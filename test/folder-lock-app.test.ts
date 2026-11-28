// Folder locks in the running app: a session in a locked folder is sealed, cannot switch to a model that is not local,
// and its requests to one fail before they are sent; a session elsewhere keeps its cloud model and cannot read the
// folder.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc } from "@earendil-works/pi-durable";

let calls: string[] = [];
const model = scriptedModel((_request, _options, _state, asked) => {
    calls.push(asked.id);

    return fauxAssistantMessage([fauxText("ok")]);
});

// faux-2 stands for a cloud model: its address is a public one (TEST-NET-3, nothing answers there).
Object.assign(model.getModel("faux-2")!, { baseUrl: "https://203.0.113.9/v1" });

// Two more cloud models, named so the model-origin registry can tell them apart.
const cloud = model.getModel("faux-2")!;

model.models.push(
    Object.assign({}, cloud, { id: "claude-sonnet-4", baseUrl: "https://api.anthropic.com/v1" }),
    Object.assign({}, cloud, { id: "gpt-5", baseUrl: "https://api.openai.com/v1" }),
    Object.assign({}, cloud, { id: "deepseek-v3", baseUrl: "https://api.deepseek.com/v1" }),
);

const vault = join(root, "vault");
const outside = join(root, "outside");
let app: Awaited<ReturnType<typeof openApp>>;

before(async () => {
    mkdirSync(vault, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(vault, "secret.md"), "the secret\n");
    app = await openApp(model);
});

after(async () => {
    await app.close();
    cleanUp();
});

test("a session in a locked folder is sealed and keeps to local models; one outside keeps its cloud model and is blind to it", async () => {
    const sealed = await newSession(app, vault);

    await say(app, sealed, "hello");
    assert.deepEqual(calls, ["faux-1"], "a local model answers as before");

    await app.lockFolder(owner(app), vault);

    assert.equal(app.sessions().find((row) => row.id === Number(sealed))?.sealed, true);
    await assert.rejects(
        app.commands.configure(sealed, owner(app), {
            model: { provider: "faux", modelId: "faux-2" },
        }),
        /locked to local models/,
        "it cannot switch to a model that is not local",
    );

    // Its model changed some other way (a router stage, a stored choice): the request still never goes.
    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(AgentDoc, sealed), {
            model: { provider: "faux", modelId: "faux-2" },
        });
    }, context);
    calls = [];
    await say(app, sealed, "send this to the cloud");
    assert.deepEqual(calls, [], "the request to the cloud model was refused before it was sent");

    // A session elsewhere: its cloud model answers, and the locked folder is not there for it.
    const other = await newSession(app, outside);

    await app.commands.configure(other, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });
    await say(app, other, "hello cloud");
    assert.deepEqual(calls, ["faux-2"]);
    assert.equal(app.sessions().find((row) => row.id === Number(other))?.sealed, undefined);

    const read = await app.envFor(other).readTextFile(join(vault, "secret.md"), context);

    assert.equal(read.ok, false);

    // Unlocking ends the seal: the lock decided which models may see the folder, and it is gone.
    app.unlockFolder(owner(app), vault);
    assert.equal(app.sealedConversation(sealed), false);
    await app.commands.configure(sealed, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });
    assert.equal(
        (await app.envFor(other).readTextFile(join(vault, "secret.md"), context)).ok,
        true,
    );
});

test("a us lock lets Claude in and keeps DeepSeek out", async () => {
    const folder = join(root, "us-vault");

    mkdirSync(folder, { recursive: true });

    const session = await newSession(app, folder);

    await app.lockFolder(owner(app), folder, [], { scope: "us" });

    const row = app.sessions().find((each) => each.id === Number(session));

    assert.deepEqual(row?.sealedPolicy, { scope: "us" });

    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(AgentDoc, session), {
            model: { provider: "faux", modelId: "claude-sonnet-4" },
        });
    }, context);

    calls = [];
    await say(app, session, "hello from a us model");
    assert.deepEqual(calls, ["claude-sonnet-4"], "the US model answered");

    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(AgentDoc, session), {
            model: { provider: "faux", modelId: "deepseek-v3" },
        });
    }, context);

    calls = [];
    await say(app, session, "send this to a chinese model");
    assert.deepEqual(calls, [], "the Chinese model was refused before the request");
});

test("a remote copy is open to its sealed session and closed to others", async () => {
    const folder = join(root, "remote-vault");

    mkdirSync(folder, { recursive: true });
    await app.setHosts(owner(app), [{ name: "aphotic", target: "tcrypt@aphotic", mode: "allow" }]);

    const session = await newSession(app, folder);

    await app.lockFolder(owner(app), folder, [], { scope: "us" }, [
        { host: "aphotic", path: "/home/tcrypt/Work" },
    ]);

    assert.deepEqual(
        app.folderLockCall(session, { host: "aphotic", path: "/home/tcrypt/Work/soteria/a" }),
        { decision: "allow" },
    );
    // A lock limits models, not reach: the sealed session goes anywhere else on that host, and to other hosts.
    assert.equal(
        app.folderLockCall(session, { host: "aphotic", path: "/home/tcrypt/Working" }).decision,
        "allow",
    );
    assert.equal(app.folderLockCall(session, { host: "aphotic" }).decision, "allow");
    assert.equal(
        app.folderLockCall(session, { host: "other", path: "/home/tcrypt/Work" }).decision,
        "allow",
    );

    // A session on a model the lock forbids is kept out of the copy, and a command there asks a person.
    const blind = await newSession(app, outside);

    await app.commands.configure(blind, owner(app), {
        model: { provider: "faux", modelId: "deepseek-v3" },
    });

    assert.equal(
        app.folderLockCall(blind, { host: "aphotic", path: "/home/tcrypt/Work/soteria/a" })
            .decision,
        "block",
    );
    assert.equal(
        app.folderLockCall(blind, { host: "aphotic", path: "/home/tcrypt/Working" }).decision,
        "allow",
    );
    assert.equal(app.folderLockCall(blind, { host: "aphotic" }).decision, "ask");

    const other = join(root, "remote-other");

    mkdirSync(other, { recursive: true });
    await assert.rejects(
        app.lockFolder(owner(app), other, [], { scope: "us" }, [
            { host: "missing", path: "/home/tcrypt/Work" },
        ]),
        /There is no host named missing/,
    );
});

test("a parent's remote copy cannot open a stricter child's path", async () => {
    const parent = join(root, "remote-parent");
    const child = join(parent, "clients");

    mkdirSync(child, { recursive: true });
    await app.setHosts(owner(app), [{ name: "aphotic", target: "tcrypt@aphotic", mode: "allow" }]);

    const session = await newSession(app, parent);

    await app.lockFolder(owner(app), parent, [], { scope: "us" }, [
        { host: "aphotic", path: "/home/tcrypt/Work" },
    ]);
    await app.lockFolder(owner(app), child, [], { scope: "anthropic" }, [
        { host: "aphotic", path: "/home/tcrypt/Work/clients" },
    ]);

    await app.commands.configure(session, owner(app), {
        model: { provider: "faux", modelId: "claude-sonnet-4" },
    });
    assert.equal(
        app.folderLockCall(session, { host: "aphotic", path: "/home/tcrypt/Work/clients/a" })
            .decision,
        "allow",
        "Claude may read the child",
    );
    assert.equal(
        app.folderLockCall(session, { host: "aphotic", path: "/home/tcrypt/Work/soteria/a" })
            .decision,
        "allow",
        "the parent's own path is under the US policy",
    );

    // Claude reached the child: the session is sealed to the child's policy and cannot switch to GPT.
    await assert.rejects(
        app.commands.configure(session, owner(app), {
            model: { provider: "faux", modelId: "gpt-5" },
        }),
        /locked to local models and Anthropic/,
    );

    const gpt = await newSession(app, outside);

    await app.commands.configure(gpt, owner(app), {
        model: { provider: "faux", modelId: "gpt-5" },
    });
    const blocked = app.folderLockCall(gpt, {
        host: "aphotic",
        path: "/home/tcrypt/Work/clients/a",
    });

    assert.equal(blocked.decision, "block");
    assert.match(blocked.reason ?? "", /allows local models and Anthropic/);
    assert.equal(
        app.folderLockCall(gpt, { host: "aphotic", path: "/home/tcrypt/Work/soteria/a" }).decision,
        "allow",
        "the parent's own path still allows a US model",
    );
});

test("a session above a locked folder reads it on a model the lock allows, and is sealed by it", async () => {
    const parent = join(root, "engagements");
    const child = join(parent, "ops");

    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "notes.md"), "ops notes\n");
    await app.lockFolder(owner(app), child, [], { scope: "anthropic" });

    const claude = await newSession(app, parent);

    await app.commands.configure(claude, owner(app), {
        model: { provider: "faux", modelId: "claude-sonnet-4" },
    });
    assert.equal(app.sealedConversation(claude), false, "working above the lock does not seal");

    const read = await app.envFor(claude).readTextFile(join(child, "notes.md"), context);

    assert.equal(read.ok && read.value, "ops notes\n");
    assert.deepEqual(app.sealedPolicy(claude)?.policy, { scope: "anthropic" });
    await assert.rejects(
        app.commands.configure(claude, owner(app), {
            model: { provider: "faux", modelId: "gpt-5" },
        }),
        /locked to local models and Anthropic/,
        "what it read keeps it off a model the lock forbids",
    );

    const gpt = await newSession(app, parent);

    await app.commands.configure(gpt, owner(app), {
        model: { provider: "faux", modelId: "gpt-5" },
    });
    assert.equal(
        (await app.envFor(gpt).readTextFile(join(child, "notes.md"), context)).ok,
        false,
        "a model the lock forbids cannot read it",
    );
    assert.equal(app.mayRead(gpt, claude), false, "nor the transcript of a session it sealed");
    assert.equal(app.sealedConversation(gpt), false);
});

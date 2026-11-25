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

    // Unlocking does not unseal: what the session read stays local.
    app.unlockFolder(owner(app), vault);
    assert.equal(app.sealedConversation(sealed), true);
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
    assert.equal(
        app.folderLockCall(session, { host: "aphotic", path: "/home/tcrypt/Working" }).decision,
        "block",
    );
    assert.equal(app.folderLockCall(session, { host: "aphotic" }).decision, "ask");
    assert.equal(
        app.folderLockCall(session, { host: "other", path: "/home/tcrypt/Work" }).decision,
        "block",
    );

    const blind = await newSession(app, outside);

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

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

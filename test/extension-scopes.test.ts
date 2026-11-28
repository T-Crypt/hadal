// Folder-scoped extensions: a drop-in named in `extensionScopes` acts only in sessions whose folder is inside one of
// its folders. Elsewhere its prompt section is absent, its hook does nothing, and its tool refuses.
import { cleanUp, context, newSession, openApp, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ContextView, ConversationId } from "@earendil-works/pi-durable";
import { ConfigStore } from "../src/server/config.ts";
import { inScope, parseExtensionScopes, scopeOf } from "../src/server/extension-scopes.ts";

after(cleanUp);

test("extensionScopes reads globs and ~/ folders, and leaves out what is not absolute", () => {
    const scopes = parseExtensionScopes(
        { "enyo-*.ts": ["~/Enyo", "relative", 3], "_x.ts": "/srv/x/" },
        "/home/me",
    );

    assert.deepEqual(scopes, { "enyo-*.ts": ["/home/me/Enyo"], "_x.ts": ["/srv/x"] });
    assert.deepEqual(scopeOf(scopes, "enyo-scope.ts"), ["/home/me/Enyo"]);
    assert.equal(scopeOf(scopes, "skills-gate.ts"), undefined);
    assert.equal(scopeOf(scopes, "xenyo-scope.ts"), undefined, "the glob is anchored");
    assert.deepEqual(parseExtensionScopes(["/a"]), {});
    assert.deepEqual(parseExtensionScopes(undefined), {});
    assert.deepEqual(
        scopeOf(parseExtensionScopes({ "a.ts": ["nope"] }), "a.ts"),
        [],
        "a scope with no usable folder acts nowhere",
    );
    assert.equal(inScope("/home/me/Enyo/10-ops", ["/home/me/Enyo"]), true);
    assert.equal(inScope("/home/me/Enyo", ["/home/me/Enyo"]), true);
    assert.equal(inScope("/home/me/Enyo-old", ["/home/me/Enyo"]), false);
    assert.equal(inScope("ssh://box/home/me/Enyo", ["/home/me/Enyo"]), false);
});

let requests: Message[][] = [];
let steps: FauxResponseStep[] = [];

const route: FauxResponseStep = (request) => {
    const messages = (request as { messages: Message[] }).messages;
    const hasTools = messages.some(
        (message) => message.role === "system" && (message.toolsAdded?.length ?? 0) > 0,
    );

    if (hasTools) {
        requests.push(messages);
    }

    const step = steps.shift() ?? fauxAssistantMessage([fauxText("done")]);

    return typeof step === "function"
        ? step(request, undefined as never, undefined as never, undefined as never)
        : step;
};

/** The prompt text a request carries: its system sections, replayed. */
const prompt = (messages: Message[]) => {
    const sections: Record<string, string> = {};

    for (const message of messages) {
        if (message.role === "system") {
            for (const [key, value] of Object.entries(message.sections ?? {})) {
                if (value === null) {
                    delete sections[key];
                } else {
                    sections[key] = value;
                }
            }
        }
    }

    return Object.values(sections).join("\n");
};

const results = async (app: Awaited<ReturnType<typeof openApp>>, id: ConversationId) => {
    const view = (await (await app.harness.conversation(id, context))!.context(
        context,
    )) as ContextView;

    return view.messages
        .filter(
            (message): message is Extract<Message, { role: "toolResult" }> =>
                message.role === "toolResult",
        )
        .map((message) => ({
            error: message.isError === true,
            text: (message.content as { text?: string }[]).map((part) => part.text ?? "").join(""),
        }));
};

const MODULE = `/** A scoped test module. */
import { defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";

export default function create() {
    return defineExtension({
        name: "scoped-test",
        sections: [section("scoped_rule", () => "SCOPED RULE TEXT")],
        tools: [defineTool({
            name: "scoped_ping",
            description: "Answers pong.",
            parameters: obj({}),
            replay: "safe",
            execute: async () => ({ output: [{ type: "text", text: "pong" }] }),
        })],
        hooks: [hook(ToolTask, {
            beforeTool: async (call) => call.name === "bash" ? { block: "SCOPED HOOK BLOCK" } : undefined,
        })],
    });
}
`;

test("a scoped drop-in acts only in sessions inside its folders", async () => {
    const data = join(root, "scoped-data");
    const inside = join(root, "engagements", "box");
    const outside = join(root, "elsewhere");

    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(data, "extensions"), { recursive: true });
    writeFileSync(join(data, "extensions", "scoped-test.ts"), MODULE);

    const model = scriptedModel(route);
    let app = await openApp(model, data);

    await app.close();

    const file = join(data, "config.json");
    const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

    config.enabledExtensions = ["scoped-test.ts"];
    config.extensionScopes = { "scoped-*.ts": [join(root, "engagements")] };
    writeFileSync(file, JSON.stringify(config));
    app = await openApp(model, data);

    try {
        assert.equal(app.loader.enabled("scoped-test.ts"), true);

        for (const [cwd, active] of [
            [inside, true],
            [outside, false],
        ] as const) {
            const id = await newSession(app, cwd);

            requests = [];
            steps = [
                () =>
                    fauxAssistantMessage([fauxToolCall("scoped_ping", {})], {
                        stopReason: "toolUse",
                    }),
                () =>
                    fauxAssistantMessage([fauxToolCall("bash", { command: "echo ran" })], {
                        stopReason: "toolUse",
                    }),
            ];
            await say(app, id, "go");

            const shown = prompt(requests[0] ?? []);
            const [ping, bash] = await results(app, id);

            if (active) {
                assert.match(shown, /SCOPED RULE TEXT/, "the section shows inside");
                assert.deepEqual(ping, { error: false, text: "pong" });
                assert.equal(bash?.error, true);
                assert.match(bash!.text, /SCOPED HOOK BLOCK/, "the hook acts inside");
            } else {
                assert.doesNotMatch(shown, /SCOPED RULE TEXT/, "no section outside");
                assert.equal(ping?.error, true);
                assert.match(ping!.text, /works only in sessions whose folder is inside/);
                assert.deepEqual(bash, { error: false, text: "ran\n" }, "no hook outside");
            }
        }
    } finally {
        await app.close();
    }
});

test("a hand-written extensionScopes survives a save from a store that loaded before it", () => {
    const dir = join(root, "scopes-hand-edit");
    const store = new ConfigStore(dir);
    const file = store.file;

    store.save();
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

    onDisk.extensionScopes = { "enyo-*.ts": ["/srv/enyo"] };
    writeFileSync(file, JSON.stringify(onDisk));

    store.save();
    const after = JSON.parse(readFileSync(file, "utf8")) as { extensionScopes?: unknown };

    assert.deepEqual(after.extensionScopes, { "enyo-*.ts": ["/srv/enyo"] });
    assert.deepEqual(store.extensionScope("enyo-scope.ts"), ["/srv/enyo"]);
});

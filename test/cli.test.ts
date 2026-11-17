import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cleanUp, openApp, owner, scriptedModel } from "./helpers.ts";
import type { App } from "./helpers.ts";
import { flags } from "../src/cli/client.ts";
import { parseFrame } from "../src/cli/events.ts";
import { figures, oneLine } from "../src/cli/render.ts";
import { Printer } from "../src/cli/view.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app.close();
    cleanUp();
});

// ─── The tab protocol's frames ──────────────────────────────────────────

test("an event frame keeps its name and its JSON", () => {
    assert.deepEqual(parseFrame('event: view\ndata: {"full":true}'), {
        name: "view",
        data: { full: true },
    });
});

test("a comment or an empty frame is no event", () => {
    assert.equal(parseFrame(": ping"), undefined);
    assert.equal(parseFrame(""), undefined);
});

test("data lines of one event join with a newline, so a pretty answer survives", () => {
    assert.deepEqual(parseFrame("event: note\ndata: first\ndata: second"), {
        name: "note",
        data: "first\nsecond",
    });
});

test("an unnamed event is a message, as in the protocol", () => {
    assert.deepEqual(parseFrame("data: 1"), { name: "message", data: 1 });
});

// ─── Flags ──────────────────────────────────────────────────────────────

test("the CLI's flags read a session, a prompt, and the leave switch", () => {
    const parsed = flags(["--session", "12", "-p", "say hi", "--leave", "--no-start"]);

    assert.equal(parsed.session, 12);
    assert.equal(parsed.prompt, "say hi");
    assert.equal(parsed.leave, true);
    assert.equal(parsed.start, false);
    assert.equal(parsed.cwd, process.cwd());
});

test("a new session and a list are separate switches", () => {
    const parsed = flags(["--new", "--list"]);

    assert.equal(parsed.fresh, true);
    assert.equal(parsed.list, true);
    assert.equal(parsed.prompt, undefined);
});

// ─── Terminal text ──────────────────────────────────────────────────────

test("oneLine cuts long text and keeps its first line", () => {
    assert.equal(oneLine("first\nsecond"), "first");
    assert.equal(oneLine("a".repeat(30), 10), `${"a".repeat(9)}…`);
});

test("figures shorten thousands for a status line", () => {
    assert.equal(figures(999), "999");
    assert.equal(figures(1234), "1.2k");
});

// ─── What a view draws ──────────────────────────────────────────────────

test("a view draws each entry once, in order, and says what a tool call did", () => {
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);

    process.stdout.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));

        return true;
    }) as typeof process.stdout.write;

    const printer = new Printer({ thinking: false, verbose: false, session: 1 });

    try {
        printer.view({
            entries: [
                { id: 1, kind: "user", text: "read the file" },
                {
                    id: 2,
                    kind: "assistant",
                    blocks: [
                        { type: "text", text: "Reading it." },
                        { type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
                    ],
                },
                { id: 3, kind: "toolResult", callId: "c1", name: "read", text: "", isError: false },
            ],
            live: { busy: false },
        });
        // A view that repeats what the terminal has is not drawn again: this is what a reattach sends.
        printer.view({
            entries: [{ id: 1, kind: "user", text: "read the file" }],
            live: { busy: false },
        });
    } finally {
        process.stdout.write = write;
    }

    const text = written.join("");

    assert.equal(text.match(/read the file/g)?.length, 1);
    assert.match(text, /Reading it\./);
    assert.match(text, /read a\.ts/);
    assert.match(text, /✓ read/);
    assert.equal(printer.answered, true);
    assert.equal(printer.busy, false);
});

test("a failed answer says so, and the printer reports the failure", () => {
    const printer = new Printer({ thinking: false, verbose: false, session: 1 });
    const write = process.stdout.write.bind(process.stdout);

    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
        printer.view({
            entries: [
                { id: 1, kind: "user", text: "do it" },
                { id: 2, kind: "assistant", blocks: [], error: "Invalid request" },
            ],
            live: { busy: false },
        });
    } finally {
        process.stdout.write = write;
    }

    assert.equal(printer.failed, true);
});

test("an approval is offered once and answered once", () => {
    const printer = new Printer({ thinking: false, verbose: false, session: 1 });
    const write = process.stdout.write.bind(process.stdout);

    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
        printer.view({
            approvals: [
                { id: "a1", tool: "bash", subject: "rm -rf build", reason: "Deletes a folder" },
            ],
        });
        printer.view({
            approvals: [
                { id: "a1", tool: "bash", subject: "rm -rf build", reason: "Deletes a folder" },
            ],
        });
    } finally {
        process.stdout.write = write;
    }

    assert.equal(printer.approval?.id, "a1");
    assert.equal(printer.takeApproval()?.id, "a1");
    assert.equal(printer.approval, undefined);
});

// ─── The server's side: a terminal session is an ordinary session ───────

test("a session created for the terminal carries client: terminal, and one made in the browser does not", async () => {
    const terminal = await app.commands.createSession(owner(app), {
        cwd: app.defaultCwd,
        client: "terminal",
    });
    const browser = await app.commands.createSession(owner(app), { cwd: app.defaultCwd });

    // What the browser reads is the same list: the field is additive and older rows lack it.
    const listed = app.sessions(owner(app));
    const terminalRow = listed.find((session) => session.id === Number(terminal.id));
    const browserRow = listed.find((session) => session.id === Number(browser.id));

    assert.equal(terminalRow?.client, "terminal");
    assert.equal(browserRow?.client, undefined);
});

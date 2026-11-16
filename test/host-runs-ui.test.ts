// The host layer in the app: a call on another machine says so on its line and in its group, the session's readout
// names the host, and the run log lists where each command ran and opens it.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs = 10_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

/** The synthetic transcript: a local command, a host command, a read there, and a failed edit here. */
const ENTRIES = `
    const now = Date.now();
    const entries = [
        { id: 930000, kind: "user", text: "look at the GPU box", images: 0, at: now - 60_000 },
        { id: 930001, kind: "assistant", at: now - 50_000, blocks: [
            { type: "toolCall", id: "h1", name: "bash", args: { command: "uname -a" } },
            { type: "toolCall", id: "h2", name: "bash", args: { command: "nvidia-smi --query-gpu=temperature.gpu", host: "gpu" } },
        ]},
        { id: 930002, kind: "toolResult", callId: "h1", text: "Linux omarchy", at: now - 47_000 },
        { id: 930003, kind: "toolResult", callId: "h2", text: "54", at: now - 44_000 },
        { id: 930004, kind: "assistant", at: now - 40_000, blocks: [
            { type: "toolCall", id: "h3", name: "read", args: { path: "/home/tcrypt/homelab/reference/llama-swap/config.yaml", host: "gpu" } },
            { type: "toolCall", id: "h4", name: "edit", args: { path: "local.txt", edits: [{ oldText: "a", newText: "b" }] } },
        ]},
        { id: 930005, kind: "toolResult", callId: "h3", text: "groups:", at: now - 36_000 },
        { id: 930006, kind: "toolResult", callId: "h4", text: "edited", isError: true, at: now - 33_000 },
    ];

    store.set((state) => ({
        view: {
            ...state.view,
            entries: new Map(entries.map((entry) => [entry.id, entry])),
            order: entries.map((entry) => entry.id),
        },
    }));
`;

/** Put the synthetic transcript in the open session. */
const inject = () =>
    inPage(`
        (async () => {
            const { store } = await import("/store.js");
            ${ENTRIES}
            return "null";
        })()
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(work, { recursive: true });
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "host-runs-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a call on a host says so in the log, the group, and the readout, and the run log lists both machines",
    real,
    async () => {
        const id = await newSession(app);

        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${id}`);
        await see(
            `return JSON.stringify(document.querySelector(".transcript") !== null)`,
            "the transcript",
        );
        await inject();

        // The two host calls wear a tag; the local calls do not.
        await see(
            `return JSON.stringify(document.querySelectorAll(".step-host").length === 2)`,
            "host tags on the host calls",
        );
        assert.deepEqual(
            await inPage<string[]>(`
                return JSON.stringify([...document.querySelectorAll(".step-host")].map((tag) => tag.textContent.trim()));
            `),
            ["@gpu", "@gpu"],
        );
        assert.equal(
            await inPage<boolean>(`
                return JSON.stringify([...document.querySelectorAll(".step-label")].some(
                    (label, index) => label.textContent === "bash" &&
                        label.parentElement.querySelector(".step-host") === null &&
                        index === 0,
                ));
            `),
            true,
        );

        // The group's own line says where it worked.
        assert.deepEqual(
            await inPage<string[]>(`
                return JSON.stringify([...document.querySelectorAll(".activity-host")].map((tag) => tag.textContent.trim()));
            `),
            ["@gpu"],
        );

        // The readout rail names the host, and its segment opens the run log.
        await see(
            `return JSON.stringify(document.querySelector(".rail-seg--host")?.textContent.includes("@gpu") === true)`,
            "the host segment",
        );
        await page.evaluate(`document.querySelector(".rail-seg--host").click()`);
        await see(
            `return JSON.stringify(document.querySelector('[data-part="host-run-list"]') !== null)`,
            "the run log",
        );

        const rows = await inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll(".host-run")].map((row) =>
                row.dataset.host + ":" + row.querySelector(".host-run-tool")?.textContent.trim(),
            ));
        `);

        assert.deepEqual(rows, ["local:edit", "gpu:read", "gpu:bash", "local:bash"]);
        assert.equal(
            await inPage<boolean>(`
                return JSON.stringify(document.querySelector(".host-runs-note")?.textContent.includes("only through a host the owner allowed") === true);
            `),
            true,
        );

        // A host filter leaves its own rows; the failed edit stays out of the host's list.
        await page.evaluate(`
            [...document.querySelectorAll(".host-filter")].find((button) => button.textContent.includes("@gpu")).click()
        `);
        await see(
            `return JSON.stringify(document.querySelectorAll(".host-run").length === 2)`,
            "the gpu filter",
        );
        assert.deepEqual(
            await inPage<string[]>(`
                return JSON.stringify([...document.querySelectorAll(".host-run")].map((row) => row.dataset.host));
            `),
            ["gpu", "gpu"],
        );

        // A row opens its call: the sheet closes, and the group shows its timeline.
        await page.evaluate(`document.querySelector(".host-run").click()`);
        await see(
            `return JSON.stringify(document.querySelector(".host-run-list") === null)`,
            "the sheet closed",
        );
    },
);

test("the phone's status line keeps one row with a host chip", real, async () => {
    const id = await newSession(app);

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".transcript") !== null)`,
        "the transcript",
    );
    await inject();
    await see(
        `return JSON.stringify(document.querySelector(".hosts-now") !== null)`,
        "the host chip",
    );

    const fit = await inPage<{ rows: number; hosts: number; short: string }>(`
            const line = document.querySelector(".status-line");
            const boxes = [...line.children]
                .map((child) => child.getBoundingClientRect())
                .filter((box) => box.width > 0);
            const middles = boxes.map((box) => Math.round(box.top + box.height / 2));

            return JSON.stringify({
                rows: new Set(middles).size,
                hosts: document.querySelector(".hosts-now").getBoundingClientRect().width,
                short: line.dataset.short ?? "",
            });
        `);

    assert.equal(fit.rows, 1, `the status line wraps: ${fit.short}`);
    assert.ok(fit.hosts > 0, "the host chip is visible");
    assert.equal(fit.short.split(" ").includes("hosts"), false);
});

// The top bar's readout (Bell): every segment is the store's own figure, the ones that open a panel are buttons, and
// "now" names the call that runs, as its row in the log does.
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
        dataDir: mkdtempSync(join(root, "readout-ui-")),
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
    "the readout names the call that runs, shows cache and schedules, and its segments open their panels",
    real,
    async () => {
        const id = await newSession(app);

        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${id}`);
        await see(
            `return JSON.stringify(document.querySelector(".rail-readout") !== null)`,
            "the readout",
        );

        // A run reading a file, a cache figure, and a scheduled message, as the store carries them.
        await inPage(`
        const { store } = await import("/store.js");

        store.set((state) => ({
            view: {
                ...state.view,
                stats: { ...(state.view.stats ?? {}), cacheRate: 0.82 },
                schedules: [{ id: "s1", text: "check", next: Date.now() + 3_600_000 }],
                live: {
                    ...state.view.live,
                    busy: true,
                    tools: [{ callId: "c1", status: "running", taskId: 1 }],
                    generation: {
                        attempt: 0,
                        message: {
                            blocks: [{ type: "toolCall", id: "c1", name: "read", args: { path: "src/server/auth.ts" } }],
                        },
                    },
                },
            },
        }));
        return "null";
    `);

        const segments = () =>
            inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll(".rail-readout .rail-seg")]
                .map((segment) => segment.textContent.trim().replace(/\\s+/g, " ")));
        `);

        await see(
            `return JSON.stringify([...document.querySelectorAll(".rail-readout .rail-seg--now")].some((segment) => segment.textContent.includes("src/server/auth.ts")))`,
            "now names the read",
        );

        const shown = await segments();

        assert.ok(
            shown.some((segment) => segment === "cache82%"),
            `cache in ${shown.join(" | ")}`,
        );
        assert.ok(
            shown.some((segment) => segment === "sched1"),
            `schedules in ${shown.join(" | ")}`,
        );
        assert.ok(
            shown.some((segment) => segment.startsWith("model")),
            "the model",
        );

        // The model segment opens the model picker; who opens people (or devices).
        await inPage(`
        [...document.querySelectorAll(".rail-readout button.rail-seg")]
            .find((segment) => segment.textContent.trim().startsWith("model"))
            .click();
        return "null";
    `);
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.sheet?.type === "model")`,
            "the model picker",
        );

        // Done: no now, the bar holds the rest.
        await inPage(`
        const { store } = await import("/store.js");

        store.set((state) => ({ sheet: null, view: { ...state.view, live: { ...state.view.live, busy: false, tools: [] } } }));
        return "null";
    `);
        await see(
            `return JSON.stringify(document.querySelector(".rail-readout .rail-seg--now") === null)`,
            "no now once the run ends",
        );
    },
);

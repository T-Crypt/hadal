// The composer's tools row on a phone, in a real browser where this machine has Chromium: the model's name stays inside
// its own pill, and no chip paints over another. The row holds places, attach, the model, subagents, Plan, the browser,
// the mic and Send, and only the model's pill can shrink; its parts cannot shrink below their own widths, so a tight row
// used to squeeze the pill past them and draw the model's name over the chip beside it.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
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
let session: ConversationId;

const phone = (width: number): Viewport => ({ ...VIEWPORTS.mobile, width });

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what);

/** Open the session at `viewport` and wait for its message box and the row under it. */
async function open(viewport: Viewport): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${session}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer-row .model-chip .model-name") !== null)`,
        `the composer's row at ${viewport.width}px`,
    );
    await page.evaluate(`
        await Promise.all(
            document
                .getAnimations()
                .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
        );
    `);
}

/**
 * In the page: the row's parts as they are painted. A box is cut to each ancestor that clips it, since what a pill
 * clips never reaches the glass.
 */
const PAINTED = `
    const row = document.querySelector(".composer-row");
    const name = (el) => {
        const part = el.dataset?.part || "";
        const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/)[0] : "";
        return part || cls || el.tagName.toLowerCase();
    };
    const painted = (el) => {
        let box = el.getBoundingClientRect();
        for (let node = el.parentElement; node && node !== row.parentElement; node = node.parentElement) {
            if (getComputedStyle(node).overflowX !== "visible") {
                const clip = node.getBoundingClientRect();
                box = {
                    left: Math.max(box.left, clip.left),
                    right: Math.min(box.right, clip.right),
                    top: Math.max(box.top, clip.top),
                    bottom: Math.min(box.bottom, clip.bottom),
                };
            }
        }
        return box;
    };
    const shown = [...row.querySelectorAll(".model-chip, .subagents-chip, .plan-chip, .browser-chip, .send-button")]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({ what: name(el), box: painted(el) }));
`;

/** The chips of the row that paint on top of one another, with how far. */
const overlaps = () =>
    inPage<string[]>(`
        ${PAINTED}
        const pairs = [];
        for (let i = 0; i < shown.length; i++) {
            for (let j = i + 1; j < shown.length; j++) {
                const a = shown[i].box, b = shown[j].box;
                const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (w > 1 && h > 1) {
                    pairs.push(shown[i].what + " x " + shown[j].what + " " + Math.round(w) + "px");
                }
            }
        }
        return JSON.stringify(pairs);
    `);

/** The model's name: how much of it reaches the glass, how wide its box is, and how wide its words are. */
const nameRoom = () =>
    inPage<{ shown: number; box: number; words: number }>(`
        ${PAINTED}
        const span = document.querySelector(".model-chip .model-name");
        const box = painted(span);
        return JSON.stringify({
            shown: Math.round(box.right - box.left),
            box: Math.round(span.getBoundingClientRect().width),
            words: span.scrollWidth,
        });
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "composer-pills-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
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

test("no chip in the tools row paints over another, from a small phone up", real, async () => {
    for (const width of [320, 360, 390, 430, 690]) {
        await open(phone(width));
        assert.deepEqual(await overlaps(), [], `the row at ${width}px`);
    }
});

test(
    "a phone's row gives up the chevron before it squeezes the model's name out of its pill",
    real,
    async () => {
        await open(phone(390));

        // The whole name shows: the pill was not squeezed past what the name needs.
        const room = await nameRoom();

        assert.equal(room.shown, room.box, `the name shows ${room.shown} of ${room.box}px`);
        assert.equal(room.box, room.words, "no ellipsis: the name fits its box");

        // The chevron is the part that gave way: the pill itself still opens the model menu.
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(getComputedStyle(document.querySelector(".model-chip .model-caret")).display === "none")`,
            ),
            true,
            "the chevron steps out on a phone",
        );
    },
);

test(
    "a long model's name ellipsises inside its pill instead of over the chips beside it",
    real,
    async () => {
        await open(phone(390));
        await page.evaluate(`
            const { store } = await import("/store.js");
            store.set({
                view: {
                    ...store.state.view,
                    agent: { ...store.state.view.agent, modelName: "claude-opus-for-very-long-names" },
                },
            });
        `);
        await see(
            `return JSON.stringify(document.querySelector(".model-chip .model-name").textContent.length > 20)`,
            "the long name",
        );

        assert.deepEqual(await overlaps(), [], "the row with a long model name");

        // Still a name, not a bare ellipsis: the words are cut inside the pill's own box, and some of them show.
        const room = await nameRoom();

        assert.ok(
            room.words > room.box,
            `the long name is cut (its box ${room.box}, its words ${room.words})`,
        );
        assert.ok(room.shown >= 30, `the name keeps ${room.shown}px of itself`);
    },
);

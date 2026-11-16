// Scrolling inside a sheet on a phone, in a real browser where this machine has Chromium: after a theme changes, the
// sheet's list must still scroll (the reveal is a view transition, which freezes the page while it runs), and a finger
// pulled down over a list that is already scrolled away from its top must reach the list, not the sheet's drag to close
// (`useDragToClose` in web/gestures.js). Reported from a phone, inside the themes.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what);

/** Wait for the page's animations (a sheet's rise, a theme's reveal) to end. */
const settle = () =>
    page.evaluate(`
        await Promise.all(
            document
                .getAnimations()
                .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
        );
    `);

/** Open Appearance on a phone and wait for its theme cards. */
async function appearance(): Promise<void> {
    await page.setViewport(VIEWPORTS.mobile);
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
    await see(
        `return JSON.stringify(document.querySelectorAll(".theme-grid .theme-card").length > 1)`,
        "the theme cards",
    );
    await settle();
}

/** The sheet's own list, which is what scrolls (`.sheet` itself clips). */
const list = () =>
    inPage<{ scroll: number; can: number; room: number; transform: string }>(`
        const body = document.querySelector(".sheet-body");
        return JSON.stringify({
            scroll: Math.round(body.scrollTop),
            can: Math.round(body.scrollHeight - body.clientHeight),
            room: Math.round(body.clientHeight),
            transform: getComputedStyle(document.querySelector(".sheet")).transform,
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
        dataDir: mkdtempSync(join(root, "theme-scroll-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    await newSession(app);
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

test("the sheet's list scrolls, and so does it again after a theme changes", real, async () => {
    await appearance();

    const before = await list();

    assert.ok(
        before.can > 60,
        `the list has room to scroll (${before.can}px, ${before.room}px tall)`,
    );

    // Scroll to the end, then back up again with the wheel: what a thumb does.
    await page.evaluate(`document.querySelector(".sheet-body").scrollTop = 9999`);
    await until(async () => (await list()).scroll > 0, "the list scrolled down");

    const down = await list();

    await page.input([{ type: "wheel", x: 195, y: 500, dy: -300 }]);
    await until(
        async () => (await list()).scroll < down.scroll,
        `the list scrolled back up (stuck at ${JSON.stringify(await list())})`,
    );

    // Choose another theme: the reveal grows from the card, and the page is frozen while it runs.
    const shown = await inPage<string>(`
        const cards = [...document.querySelectorAll(".theme-grid .theme-card")];
        const other = cards.find((card) => !card.classList.contains("on"));
        other.scrollIntoView({ block: "center" });
        const title = other.textContent.trim().slice(0, 40);
        other.click();
        return JSON.stringify(title);
    `);

    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(!document.documentElement.classList.contains("theme-vt"))`,
            )) === true,
        `the reveal for ${shown} ended`,
    );
    await settle();

    const after = await list();

    assert.equal(after.transform, "none", "the sheet is back where it belongs");

    // Scroll up again: still the list's to do.
    await page.evaluate(`document.querySelector(".sheet-body").scrollTop = 9999`);
    const end = await list();

    await page.input([{ type: "wheel", x: 195, y: 500, dy: -300 }]);
    await until(
        async () => (await list()).scroll < end.scroll,
        `the list scrolls up after the theme changed (stuck at ${JSON.stringify(await list())})`,
    );
});

test(
    "a finger pulled down over a scrolled list reaches the list, not the sheet's drag",
    real,
    async () => {
        await appearance();
        await page.evaluate(`document.querySelector(".sheet-body").scrollTop = 200`);
        await until(async () => (await list()).scroll > 0, "the list scrolled down");

        // The app's own gesture path: `useDragToClose` listens for touch on the sheet and leaves the scroll alone when
        // something between the finger and the sheet can still scroll that way. Touch events a script makes drive the
        // same handlers a finger does here; nothing in the gesture path asks for a trusted one.
        const swipe = await inPage<{ held: boolean; moved: number; drag: string }>(`
            const body = document.querySelector(".sheet-body");
            const box = body.getBoundingClientRect();
            const at = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + 120) };
            const touch = (y) => new Touch({ identifier: 7, target: body, clientX: at.x, clientY: y });
            const send = (type, y) => {
                const one = touch(y);
                const event = new TouchEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    touches: type === "touchend" ? [] : [one],
                    targetTouches: type === "touchend" ? [] : [one],
                    changedTouches: [one],
                });
                body.dispatchEvent(event);
                return event.defaultPrevented;
            };

            send("touchstart", at.y);
            const held = send("touchmove", at.y + 60);
            send("touchend", at.y + 60);

            const sheet = document.querySelector(".sheet");
            const moved = body.scrollTop;
            return JSON.stringify({ held, moved, drag: sheet.style.transform || "none" });
        `);

        assert.equal(swipe.held, false, "the sheet let the swipe through to the list");
        assert.equal(swipe.drag, "none", `the sheet did not follow the finger (${swipe.drag})`);
    },
);

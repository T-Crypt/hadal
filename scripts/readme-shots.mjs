// Regenerates the two previews the README shows: `site/shots/desktop.webp` (a session on a desktop) and
// `site/shots/chat-phone.webp` (the same session on a phone). It starts a HADAL of its own on a temporary folder with
// the scripted model, holds one short exchange in it, renders the page in headless Chromium, and writes the files. It
// reads no data folder, calls no real model, and shows no one's conversation. Run from the repository root:
//
//   node scripts/readme-shots.mjs
//
// The scripted model answers from `EXCHANGES` below, keyed on what was asked, so an extra request (a title, a retry)
// cannot shift the answers out of order. Change `EXCHANGES` and the previews change with it.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Where to import `playwright-core` from. Nothing else in HADAL needs it, so it is not a dependency here: take one
 * from the repository if it is ever installed, then the copy the web-shot tool keeps, and say what to do when neither
 * is there.
 */
function playwrightSource() {
    const local = `${process.env.HOME}/.local/share/web-shot/node_modules/playwright-core/index.mjs`;

    if (existsSync(local)) {
        return pathToFileURL(local).href;
    }

    throw new Error(
        "This needs playwright-core to drive a browser. Run `npm install --no-save playwright-core`, or install the web-shot tool.",
    );
}

/** The turns in the previewed session, in order: what a person asked, and what HADAL answered. */
export const EXCHANGES = [
    {
        ask: "Can I get the bikes across the water in the morning?",
        key: "bikes across",
        answer: "Two crossings carry bikes:\n\n- **08:00** out, and **17:20** back\n- the 21:20 last boat takes them too, if you are late\n\nThe rest run every 40 minutes from 06:00.",
    },
    {
        ask: "And on a Sunday?",
        key: "Sunday",
        answer: "Sundays start at 09:20. The bike times hold.",
    },
];

/** The text of the newest message from a person, whatever shape its content parts take. */
function lastAsk(context) {
    const last = context.messages.findLast((message) => message.role === "user");
    const content =
        typeof last?.content === "string" ? [{ text: last.content }] : (last?.content ?? []);

    return content.flatMap((part) => (part.text ? [part.text] : [])).join("");
}

async function main() {
    // The test helpers point HADAL's config and data at a temporary folder as they load, so import them first.
    const { newSession, openApp, say, scriptedModel } = await import("../test/helpers.ts");
    const { createHandler } = await import("../src/server/http.ts");
    const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai/providers/faux");
    const { chromium } = await import(playwrightSource());

    const answer = (context) =>
        fauxAssistantMessage([
            fauxText(
                (EXCHANGES.find((turn) => lastAsk(context).includes(turn.key)) ?? EXCHANGES.at(-1))
                    .answer,
            ),
        ]);
    const model = scriptedModel();

    model.setResponses(Array.from({ length: 12 }, () => answer));

    const base = mkdtempSync(join(tmpdir(), "hadal-readme-shots-"));
    // The name shows in the previews: it is the environment the session runs in.
    const work = join(base, "ferry");

    mkdirSync(join(ROOT, "site", "shots"), { recursive: true });
    mkdirSync(work, { recursive: true });

    const app = await openApp(model, join(base, "data"));
    const session = await newSession(app, work);

    for (const turn of EXCHANGES) {
        await say(app, session, turn.ask);
    }

    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    // The server asks a new browser to sign in; the fixture's own owner token does that without a person.
    const url = `http://127.0.0.1:${server.address().port}/login?token=${encodeURIComponent(app.config.ownerToken)}`;
    const browser = await chromium.launch({
        args: [
            "--allow-file-access-from-files",
            "--disable-dev-shm-usage",
            "--force-color-profile=srgb",
            "--no-sandbox",
        ],
    });
    const problems = [];

    for (const shot of [
        { name: "desktop.webp", scale: 2, viewport: { height: 900, width: 1440 } },
        { name: "chat-phone.webp", scale: 3, viewport: { height: 844, width: 390 } },
    ]) {
        const context = await browser.newContext({
            deviceScaleFactor: shot.scale,
            reducedMotion: "reduce",
            viewport: shot.viewport,
        });

        // Dark is the scheme HADAL ships with, and these are read on a dark README.
        await context.addInitScript(() => localStorage.setItem("hadal.theme", "dark"));

        const page = await context.newPage();

        page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
        page.on("console", (message) => {
            if (message.type() === "error") {
                problems.push(`console: ${message.text()}`);
            }
        });
        await page.goto(url, { waitUntil: "load" });
        await page.waitForFunction(
            () =>
                document.querySelector('[data-part="session-list"]') !== null ||
                document.querySelector('[data-part="transcript"]') !== null,
            { timeout: 30_000 },
        );
        // The session list holds the one session. A page that reopened it straight away needs nothing clicked.
        await page.evaluate(() => {
            document
                .querySelector('[data-part="session-list"] [data-part="session-button"]')
                ?.click();
        });
        // The transcript is drawn and holds the last answer: the session is complete on screen, not only on the server.
        await page.waitForSelector('[data-part="transcript"]', { timeout: 30_000 });
        await page.waitForFunction(
            (text) => document.body.innerText.includes(text),
            EXCHANGES.at(-1).answer.split("\n")[0].replace(/[*_`]/g, ""),
            { timeout: 30_000 },
        );
        await page.waitForTimeout(700);
        await page.screenshot({
            path: join(ROOT, "site", "shots", shot.name),
            quality: 82,
            type: "webp",
        });
        console.log(`wrote site/shots/${shot.name}`);
        await context.close();
    }

    await browser.close();
    server.close();
    rmSync(base, { force: true, recursive: true });

    if (problems.length > 0) {
        console.log(`problems: ${problems.join(" | ")}`);
        process.exit(1);
    }
}

await main();

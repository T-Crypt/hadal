/**
 * `hadal cli` and `hadal run`: one terminal tab in a HADAL session. The tab signs in, joins or starts a session, and
 * speaks the same tab protocol a browser does, so the session is an ordinary one that the browser shows at `/s/<id>`
 * with a "terminal" chip. The run itself lives on the server: closing the terminal does not stop it, and joining the
 * session again picks it up.
 */
import { createInterface } from "node:readline";
import { resolveDataDir } from "../server/env.ts";
import {
    apiJson,
    type Flags,
    flags,
    HELP,
    loadConfig,
    loadSession,
    type Me,
    ownerTokenFromDisk,
    saveConfig,
    saveSession,
    type SessionSummary,
} from "./client.ts";
import { followStream, SignInRefused } from "./events.ts";
import { dim, paint, say } from "./render.ts";
import { type Attached, reachServer, stopServer } from "./server.ts";
import { Printer } from "./view.ts";

const argv = process.argv.slice(2);
const mode = argv[0] === "cli" || argv[0] === "run" ? argv[0] : "cli";
const options = flags(mode === argv[0] ? argv.slice(1) : argv);

if (options.help) {
    console.log(HELP);
    process.exit(0);
}

const config = loadConfig();
const serverUrl = (options.server ?? config.serverUrl ?? "http://127.0.0.1:8787").replace(
    /\/$/,
    "",
);
const token =
    options.token ?? process.env.HADAL_TOKEN ?? loadSession()?.token ?? ownerTokenFromDisk();

if (token === undefined || token === "") {
    console.error(
        "No token. Run this on the server's machine, set HADAL_TOKEN, or sign in once and pass --token.",
    );
    process.exit(1);
}

const controller = new AbortController();
let attached: Attached = { started: false };
let printer: Printer | undefined;
let sessionId: number | undefined;
let sent = false;
let stopping = false;

/** Leave: stop reading, stop the server this command started (unless told to leave it), say how to come back. */
async function leave(code: number, note?: string): Promise<never> {
    if (!stopping) {
        stopping = true;
        printer?.settle();
        controller.abort();

        if (attached.started && !options.leave) {
            say(dim("  stopping the server this command started"));
            await stopServer(attached);
        }

        if (note !== undefined) {
            say(note);
        }
    }

    // Let what was written drain before the process ends: a piped stdout may still be holding it.
    await new Promise((resolve) => process.stdout.write("", resolve));
    process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
        const where =
            sessionId === undefined ? "" : ` Join it again with: hadal cli --session ${sessionId}`;

        void leave(130, dim(`  detached.${where}`));
    });
}

// ─── The server, the person, the session ────────────────────────────────

try {
    attached = await reachServer({
        url: serverUrl,
        data: resolveDataDir(),
        cwd: options.cwd,
        start: options.start,
        log: (text) => say(dim(`  ${text}`)),
    });
} catch (error) {
    console.error(`  ${(error as Error).message}`);
    await leave(1);
}

const me = await apiJson<Me>(serverUrl, token, "/api/me").catch((error: Error) => {
    console.error(`  ${error.message}`);
    console.error(dim("  Sign in once in a browser, then pass its token with --token."));

    return undefined;
});

if (me === undefined) {
    await leave(1);
}

const person = me as Me;

saveSession({ token });
saveConfig({ ...config, serverUrl });
say(
    `${paint("HADAL", "signal")} ${dim("·")} ${person.user.name} ${dim(`(${person.user.role})`)} ${dim("·")} ${serverUrl}`,
);

const sessions = await apiJson<SessionSummary[]>(serverUrl, token, "/api/sessions");

if (options.list) {
    for (const session of sessions) {
        say(
            [
                `  ${String(session.id).padStart(5)}`,
                `${session.title ?? "(new session)"}`.padEnd(36).slice(0, 36),
                session.client === "terminal" ? paint("terminal", "second") : dim("browser "),
                session.busy === true ? paint("busy", "warn") : dim("idle "),
                dim(session.cwd),
            ].join("  "),
        );
    }

    await leave(0);
}

const open = await chooseSession(sessions, options, config.lastSession).catch(
    async (error: Error): Promise<number> => {
        console.error(`  ${error.message}`);
        await leave(1);

        return 0;
    },
);

sessionId = open;
const chosen = sessions.find((session) => session.id === open);

if (chosen?.model === undefined) {
    await ensureModel(open, person);
}

const webUrl = `${serverUrl}/s/${open}`;

say(
    `${paint("session", "signal")} ${open} ${dim("·")} ${chosen?.title ?? "new session"} ${dim("·")} ${webUrl}`,
);
saveConfig({ ...config, serverUrl, lastSession: open });

// ─── The tab ────────────────────────────────────────────────────────────

printer = new Printer({ thinking: options.thinking, verbose: options.verbose, session: open });

const followed = followStream({
    url: serverUrl,
    token,
    conversation: sessionId!,
    signal: controller.signal,
    onEvent: (event) => {
        if (event.name === "view") {
            printer?.view(event.data);
            settleRun();
        }
    },
    onLost: (retryInMs) => {
        say(
            dim(
                `  connection lost: retrying in ${Math.round(retryInMs / 1000)}s (the run goes on)`,
            ),
        );
    },
}).catch(async (error: Error) => {
    if (!stopping) {
        console.error(`  ${error.message}`);
        await leave(error instanceof SignInRefused ? 1 : 1);
    }
});

/** In `run`, exit when the answer to the send has landed and the run is quiet. */
function settleRun(): void {
    if (mode !== "run" || !sent || printer === undefined) {
        return;
    }

    if (printer.busy || !printer.answered) {
        return;
    }

    void leave(printer.failed ? 1 : 0, dim("  done"));
}

/** Send one message, and keep its request id across a retry: the server runs it once either way. */
async function send(text: string): Promise<boolean> {
    const requestId = crypto.randomUUID();

    printer?.sent();
    sent = true;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await apiJson(serverUrl, token!, `/api/c/${sessionId}/submit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, requestId }),
            });

            return true;
        } catch (error) {
            if (attempt === 1) {
                say(paint(`  ${(error as Error).message}`, "err"));
                sent = false;

                return false;
            }

            say(dim("  the send did not arrive: trying again with the same request"));
        }
    }

    return false;
}

// ─── Input ──────────────────────────────────────────────────────────────

async function onLine(line: string): Promise<void> {
    const text = line.trim();
    const approval = printer?.approval;

    // An approval takes the next y or n, so the answer never becomes a message.
    if (approval !== undefined && (text === "y" || text === "n")) {
        printer?.takeApproval();
        const allow = text === "y";

        void apiJson(serverUrl, token!, `/api/approvals/${encodeURIComponent(approval.id)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ allow }),
        }).then(
            () => say(dim(`  ${allow ? "allowed" : "denied"}`)),
            (error: Error) => say(paint(`  ${error.message}`, "err")),
        );

        return;
    }

    if (text === "") {
        return;
    }

    if (text === "/exit" || text === "/quit") {
        await leave(0);

        return;
    }

    if (text === "/stop") {
        void apiJson(serverUrl, token!, `/api/c/${sessionId}/abort`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        }).then(
            () => say(dim("  stopping the run")),
            (error: Error) => say(paint(`  ${error.message}`, "err")),
        );

        return;
    }

    if (text === "/open") {
        say(`  ${webUrl}`);

        return;
    }

    if (text === "/help") {
        say(
            dim(
                "  /stop  stop the run · /open  the browser address · /exit  detach (the run goes on)",
            ),
        );

        return;
    }

    await send(text);
}

if (mode === "cli") {
    const answers = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });

    answers.on("line", (line) => void onLine(line));
    answers.on("close", () => void leave(0));
} else if (options.prompt !== undefined) {
    await send(options.prompt);
} else {
    console.error('  nothing to run: pass -p "text"');
    await leave(1);
}

await followed.catch(() => {});

// ─── Choose ─────────────────────────────────────────────────────────────

async function chooseSession(
    list: SessionSummary[],
    chosen: Flags,
    last: number | undefined,
): Promise<number> {
    if (chosen.session !== undefined) {
        if (!list.some((session) => session.id === chosen.session)) {
            throw new Error(`No session ${chosen.session} on this server.`);
        }

        return chosen.session;
    }

    if (chosen.fresh || chosen.prompt !== undefined) {
        return create(chosen.cwd);
    }

    const known = list.find((session) => session.id === last);

    if (known !== undefined && list.length === 1) {
        return known.id;
    }

    // The recent ones, newest first, as rows the person can pick by number: the same order the browser shows.
    const recent = [...list]
        .sort((a, b) => (b.updatedAt ?? b.id) - (a.updatedAt ?? a.id))
        .slice(0, 12);

    if (recent.length === 0) {
        return create(chosen.cwd);
    }

    say("");
    recent.forEach((session, index) => {
        const mark = session.id === last ? paint("→", "signal") : " ";

        say(
            `  ${mark} ${String(index + 1).padStart(2)}) ${String(session.id).padStart(5)}  ${(session.title ?? "(new session)").slice(0, 34).padEnd(34)}  ${dim(session.cwd)}`,
        );
    });
    say(`  ${dim("n) a new session")}`);

    const answer = await ask(`  join which? [1-${recent.length}, n] `);
    const picked = Number(answer);

    if (Number.isInteger(picked) && picked >= 1 && picked <= recent.length) {
        return recent[picked - 1]!.id;
    }

    if (answer === "" && known !== undefined) {
        return known.id;
    }

    return create(chosen.cwd);
}

function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
        const reader = createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        });

        reader.question(question, (answer) => {
            reader.close();
            resolve(answer.trim());
        });
    });
}

/** Start a session: the same route the browser uses, marked as a terminal's. */
async function create(cwd: string): Promise<number> {
    const made = await apiJson<{ id: number }>(serverUrl, token!, "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, client: "terminal" }),
    });

    return made.id;
}

/**
 * Give a session a model, so a send is not refused: the server's own default when it has one, else the router's local
 * pair, which is what the browser would start with.
 */
async function ensureModel(id: number, person: Me): Promise<void> {
    const chosen =
        person.server.defaultModel === undefined || person.server.defaultModel === null
            ? (person.models.find(
                  (entry) => entry.provider === "llama-swap" && entry.id === "agent",
              ) ?? person.models.find((entry) => entry.provider === "llama-swap"))
            : {
                  provider: person.server.defaultModel.provider,
                  modelId: person.server.defaultModel.modelId,
              };

    if (chosen === undefined) {
        return;
    }

    const model = "modelId" in chosen ? chosen : { provider: chosen.provider, modelId: chosen.id };

    await apiJson(serverUrl, token!, `/api/c/${id}/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, thinkingLevel: "off" }),
    }).catch((error: Error) => say(paint(`  could not pick a model: ${error.message}`, "warn")));
}

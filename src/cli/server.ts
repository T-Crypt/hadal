/**
 * The server a CLI tab talks to. When nothing answers on the port, the CLI starts the launcher (the same process
 * `hadal serve` runs), waits until it answers, and stops it on the way out unless the person said to leave it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

/** The launcher this checkout runs, so an attached server is the same build as the CLI beside it. */
const LAUNCHER = fileURLToPath(new URL("../../bin/hadal.js", import.meta.url));
/** How long a started server may take to answer before the CLI calls it a failure (a first start makes folders and a database). */
const READY_LIMIT_MS = 90_000;

export interface Attached {
    /** True when this CLI started the server, so it stops it on the way out. */
    started: boolean;
    child?: ChildProcess;
}

/** Whether anything answers on `url`. A 401 is an answer: the server is up and the token is the question. */
export async function serverAnswers(url: string): Promise<boolean> {
    try {
        const response = await fetch(`${url}/api/pocket/info`, {
            signal: AbortSignal.timeout(1500),
        });

        await response.body?.cancel().catch(() => {});

        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Use the server on the port, or start one and wait for it. `start: false` only checks, so a CLI can say "no server
 * here" instead of starting one.
 */
export async function reachServer(options: {
    url: string;
    data: string;
    cwd: string;
    start: boolean;
    log: (text: string) => void;
}): Promise<Attached> {
    if (await serverAnswers(options.url)) {
        return { started: false };
    }

    if (!options.start) {
        throw new Error(
            `No HADAL server answers on ${options.url}. Start one with \`hadal\` first.`,
        );
    }

    const port = new URL(options.url).port || "8787";
    const child = spawn(
        process.execPath,
        [
            LAUNCHER,
            "--access",
            "local",
            "--port",
            port,
            "--yes",
            "--data",
            options.data,
            "--cwd",
            options.cwd,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";

    const keep = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-4000);
    };

    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    options.log(`No server on ${options.url}: starting one.`);
    const startedAt = Date.now();

    for (;;) {
        if (child.exitCode !== null) {
            throw new Error(
                `The server stopped while starting (${child.exitCode}).${output === "" ? "" : `\n${output.trim()}`}`,
            );
        }

        if (await serverAnswers(options.url)) {
            return { started: true, child };
        }

        if (Date.now() - startedAt > READY_LIMIT_MS) {
            child.kill("SIGTERM");

            throw new Error(`The server did not answer within ${READY_LIMIT_MS / 1000} seconds.`);
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

/** Stop a server this CLI started: SIGTERM, then SIGKILL after ten seconds, as the launcher does for its own child. */
export async function stopServer(attached: Attached): Promise<void> {
    const child = attached.child;

    if (!attached.started || child === undefined || child.exitCode !== null) {
        return;
    }

    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);

    await once(child, "exit").catch(() => {});
    clearTimeout(timer);
}

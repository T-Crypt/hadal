/**
 * `hadal cli`'s client side: where the server is, which token signs in, the tab protocol's calls, and the small files
 * the CLI keeps in the data folder. The CLI is a tab, not a harness: everything that decides what a run does lives on
 * the server, and the CLI reads and sends.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../server/env.ts";

export interface CliConfig {
    serverUrl?: string;
    leaveServer?: boolean;
    /** The session the last `hadal cli` used, so the next one joins it again with nothing to type. */
    lastSession?: number;
}

/** The token the CLI signs in with, kept out of `cli.json` so the config can be shared and the token left at 0600. */
export interface CliSession {
    token: string;
}

export interface SessionSummary {
    id: number;
    title?: string;
    cwd: string;
    model?: string;
    busy?: boolean;
    client?: "terminal";
    createdAt?: number;
    updatedAt?: number;
}

export interface Me {
    user: { id: string; name: string; role: string };
    server: { defaultModel?: { provider: string; modelId: string } | null };
    models: { provider: string; id: string; name: string }[];
}

const dataDir = () => resolveDataDir();
const configFile = () => join(dataDir(), "cli.json");
const sessionFile = () => join(dataDir(), "cli-session.json");

export function loadConfig(): CliConfig {
    try {
        return JSON.parse(readFileSync(configFile(), "utf8")) as CliConfig;
    } catch {
        return {};
    }
}

export function saveConfig(config: CliConfig): void {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function loadSession(): CliSession | undefined {
    try {
        return JSON.parse(readFileSync(sessionFile(), "utf8")) as CliSession;
    } catch {
        return undefined;
    }
}

export function saveSession(session: CliSession): void {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile(), `${JSON.stringify(session)}\n`, { mode: 0o600 });
}

/**
 * The owner token the server keeps in its own data folder, for a CLI run on the server's machine. This is what makes
 * `hadal cli` work with no token setup at all when both run as the same person.
 */
export function ownerTokenFromDisk(): string | undefined {
    try {
        const config = JSON.parse(readFileSync(join(dataDir(), "config.json"), "utf8")) as {
            ownerToken?: string;
        };

        return config.ownerToken;
    } catch {
        return undefined;
    }
}

export async function apiFetch(
    url: string,
    token: string,
    path: string,
    init: RequestInit = {},
): Promise<Response> {
    const headers = new Headers(init.headers);

    headers.set("Authorization", `Bearer ${token}`);

    if (init.method !== undefined && init.method !== "GET" && init.method !== "HEAD") {
        headers.set("X-Pocket", "1");
    }

    return fetch(`${url}${path}`, { ...init, headers });
}

/** A JSON call whose failure carries the server's own message, so a refused send says why. */
export async function apiJson<T>(
    url: string,
    token: string,
    path: string,
    init: RequestInit = {},
): Promise<T> {
    const response = await apiFetch(url, token, path, init);

    if (!response.ok) {
        let detail = "";

        try {
            const body = (await response.json()) as { error?: { message?: string } | string };

            detail = typeof body.error === "string" ? body.error : (body.error?.message ?? "");
        } catch {
            detail = "";
        }

        throw new Error(`${path} answered ${response.status}${detail === "" ? "" : `: ${detail}`}`);
    }

    return (await response.json()) as T;
}

export interface Flags {
    token?: string;
    server?: string;
    data?: string;
    cwd: string;
    prompt?: string;
    session?: number;
    fresh: boolean;
    list: boolean;
    start: boolean;
    leave: boolean;
    thinking: boolean;
    verbose: boolean;
    help: boolean;
    /** The first option this command does not know, so a typo fails instead of being skipped. */
    unknown?: string;
}

export function flags(argv: string[]): Flags {
    const result: Flags = {
        cwd: process.cwd(),
        fresh: false,
        list: false,
        start: true,
        leave: false,
        thinking: false,
        verbose: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]!;
        const value = () => argv[++index];

        if (arg === "--token") {
            result.token = value();
        } else if (arg === "--server") {
            result.server = value();
        } else if (arg === "--data") {
            result.data = value();
        } else if (arg === "--cwd") {
            result.cwd = value() ?? result.cwd;
        } else if (arg === "-p" || arg === "--prompt") {
            result.prompt = value();
        } else if (arg === "--session" || arg === "-s") {
            result.session = Number(value());
        } else if (arg === "--new") {
            result.fresh = true;
        } else if (arg === "--list") {
            result.list = true;
        } else if (arg === "--no-start") {
            result.start = false;
        } else if (arg === "--leave") {
            result.leave = true;
        } else if (arg === "--thinking") {
            result.thinking = true;
        } else if (arg === "--verbose") {
            result.verbose = true;
        } else if (arg === "--help" || arg === "-h") {
            result.help = true;
        } else if (arg.startsWith("-")) {
            result.unknown = arg;
        }
    }

    return result;
}

/** `hadal cli`'s help: the two modes, the flags, and where the session shows up in the browser. */
export const HELP = `hadal cli: this machine's terminal, in a HADAL session.

Usage:
  hadal cli                      join a session, or start one, and type in it
  hadal cli --session 12         join session 12 (the one in the browser at /s/12)
  hadal cli --new                start a new session
  hadal cli --list               list the sessions and exit
  hadal run -p "text"            send one message, wait for the run, and exit
  hadal run -p "text" --leave    keep the server running afterwards

Options:
  --server URL    Where the server is (default http://127.0.0.1:8787)
  --data DIR      The data folder (default ~/.hadal, the same as HADAL_DIR)
  --token TOKEN   The owner token or a browser sign-in token (default: this data folder's owner token)
  --cwd DIR       Folder for a new session (default: the folder you are in)
  -p, --prompt    The message to send (with \`run\`)
  -s, --session   The session id to join
  --no-start      Do not start a server when none answers
  --leave         Leave a server this command started running when it exits
  --thinking      Show the model's thinking
  --verbose       Show each tool's output
  -h, --help      This help

A session the CLI uses is an ordinary session: it shows in the browser at /s/<id>, with a "terminal"
chip. The run lives on the server, so closing the terminal does not stop it: join again with
--session <id>.`;

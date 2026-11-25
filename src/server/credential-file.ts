/**
 * HADAL's credential store for the shared sign-in file (auth.json): one sign-in per provider, the one HADAL
 * and the HADAL terminal share. It reads and writes the file under the same lock protocol the terminal uses,
 * so a sign-in in either never overwrites the other. HADAL's named accounts (accounts.ts) sit beside this
 * file; the default account of each provider is what is here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, type WriteFileOptions } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type FileData = Record<string, Credential>;

/** The same write options the terminal uses for its sign-in file. */
const WRITE_OPTIONS: WriteFileOptions = { encoding: "utf-8", mode: 0o600 };

/** How long a held lock is kept before a waiting caller takes it over, the same as the terminal's. */
const STALE_MS = 30_000;

/** The waiting deadline: a lock held longer than this is a dead holder, not a slow one. */
const DEADLINE_MS = 30_000;

/** Parse the file's sign-ins; a missing file has none. A damaged file is an error, not an empty view. */
function parseFile(authPath: string): FileData {
    if (!existsSync(authPath)) {
        return {};
    }

    let text = readFileSync(authPath, "utf-8");

    if (text.startsWith("\uFEFF")) {
        text = text.slice(1);
    }

    if (text.trim() === "") {
        return {};
    }

    return JSON.parse(text) as FileData;
}

/** Hold the sign-in file's lock across one read-write, waiting at most `DEADLINE_MS` for a slow holder. */
async function withLock<T>(authPath: string, fn: (current: FileData) => Promise<T>): Promise<T> {
    // The terminal creates the file and its parent dir before it locks; locking a missing file throws ENOENT.
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });

    if (!existsSync(authPath)) {
        writeFileSync(authPath, "{}", WRITE_OPTIONS);
    }

    const deadline = Date.now() + DEADLINE_MS;
    let retry = 0;

    for (;;) {
        let release;

        try {
            release = await lockfile.lock(authPath, {
                retries: 0,
                stale: STALE_MS,
                onCompromised: () => {},
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;

            if (code !== "ELOCKED" && code !== "EPERM" && code !== "EAGAIN") {
                throw error;
            }

            if (Date.now() > deadline) {
                throw new Error(
                    `Still locked after ${DEADLINE_MS / 1000} s: another process holds the sign-in file's lock.`,
                );
            }

            const delay = Math.min(10 * 2 ** retry, 1000);

            retry++;
            await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 10));

            continue;
        }

        try {
            return await fn(parseFile(authPath));
        } finally {
            await release().catch(() => {});
        }
    }
}

/** One credential store over the shared sign-in file. Reads are fresh, so a sign-in made in the terminal shows here at once. */
export class FileCredentialStore implements CredentialStore {
    readonly #authPath: string;

    constructor(authPath = join(getAgentDir(), "auth.json")) {
        this.#authPath = authPath;
    }

    /** The file's sign-ins now; a missing file has none, and a damaged one is an error a write must not hide. */
    #readData(): FileData {
        return parseFile(this.#authPath);
    }

    #write(data: FileData): void {
        mkdirSync(dirname(this.#authPath), { recursive: true, mode: 0o700 });
        writeFileSync(this.#authPath, JSON.stringify(data, undefined, 2) + "\n", WRITE_OPTIONS);
    }

    async read(providerId: string): Promise<Credential | undefined> {
        return this.#readData()[providerId];
    }

    async list(): Promise<readonly CredentialInfo[]> {
        return Object.entries(this.#readData()).map(([providerId, credential]) => ({
            providerId,
            type: credential.type,
        }));
    }

    async modify(
        providerId: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
        let result: Credential | undefined;

        await withLock(this.#authPath, async (current) => {
            const next = await fn(current[providerId]);

            // undefined leaves the entry unchanged, as the terminal's store does.
            if (next === undefined) {
                result = current[providerId];

                return undefined;
            }

            if (JSON.stringify(next) !== JSON.stringify(current[providerId])) {
                const data = { ...current };

                data[providerId] = next;
                this.#write(data);
            }

            result = next;

            return undefined;
        });

        return result;
    }

    async delete(providerId: string): Promise<void> {
        await withLock(this.#authPath, async (current) => {
            if (!(providerId in current)) {
                return undefined;
            }

            delete current[providerId];
            this.#write(current);

            return undefined;
        });
    }
}

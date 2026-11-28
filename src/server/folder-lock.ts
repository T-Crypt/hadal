/**
 * Folder locks: folders only the models a policy allows may see (since 0.29.0). A lock decides which models may
 * work with a folder. It does not limit where an allowed model may reach: other folders, other hosts, the network.
 *
 * The owner locks a folder (`~/clients`). From then on:
 *
 * - **A session that works in it is sealed.** Its requests may go only to a model on this machine, the LAN, or the
 *   tailnet (`Locality`); a request to any other model fails before it is sent (`installLockGate`). A seal lasts:
 *   moving the session's folder, or unlocking the folder, does not let its transcript go to a cloud model. Subagents
 *   of a sealed session are sealed with it, and so is Lantern once it reads a sealed session. A seal whose lock is
 *   gone has no effect.
 * - **A session whose model the policy does not allow is blind to it.** A session on an allowed model may work
 *   there, and is sealed to the lock's policy when its file tools reach inside. Its file tools refuse any path that
 *   resolves into a locked folder
 *   (symlinks included), and its commands run in a bubblewrap sandbox in which each locked folder is an empty
 *   directory (`sandboxArgs`). The sandbox also hides what holds copies of a locked folder: HADAL's own database and
 *   uploads, other harnesses' session logs for it, git worktrees of a locked repository, and the ways out of a mount
 *   namespace that a command could use to read it anyway: other processes' `/proc/<pid>/root` (a user namespace of its
 *   own), the user's D-Bus and
 *   systemd (`systemd-run --user`), tmux servers, and SSH keys and agent (`ssh localhost`).
 *
 * With no lock and no sealed session, none of this runs: commands start as before, and no request waits.
 *
 * What it does not cover, said plainly: services on loopback that run commands without signing in (the sandbox
 * shares the network), SSH-host workspaces (they run on another machine), and anything a sealed session wrote outside
 * its folder by its own choice. A lock works from the moment it is set: what reached a cloud model before is not
 * called back.
 *
 * State lives in `folder-locks.json` in the data folder, written only by the owner's requests. Sessions in a locked
 * folder see the file read-only, so a session cannot unlock its own folder. An unreadable file fails closed: every
 * request to a model that is not local fails until it is fixed.
 */
import { lookup } from "node:dns/promises";
import {
    existsSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { homedir, userInfo } from "node:os";
import {
    basename,
    delimiter,
    dirname,
    isAbsolute,
    join,
    normalize,
    posix,
    resolve,
    sep,
} from "node:path";
import {
    type Api,
    type AssistantMessage,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
    type Model,
} from "@earendil-works/pi-ai";
import {
    err,
    ExecutionError,
    type ExecutionEnv,
    FileError,
    ok,
} from "@earendil-works/pi-durable/env";
import {
    type LockPolicy,
    type ModelOrigin,
    allows,
    classify,
    describePolicy,
    parsePolicy,
} from "./model-origin.ts";

/** A copy of a locked folder on another machine HADAL reaches through its SSH hosts. */
export interface RemoteLock {
    /** The host's name in Menu -> Hosts. */
    host: string;
    /** The folder on that machine, absolute and with `/` separators. */
    path: string;
}

/** One locked folder, as the owner set it. */
export interface FolderLock {
    /** The folder, absolute, as the owner gave it. */
    path: string;
    /** More paths to hide from other sessions: copies of the folder that live elsewhere. */
    hide: string[];
    /** When it was locked. */
    at: number;
    /** Who locked it. */
    by?: string;
    /** Who may see it: local models, or local and the cloud companies this names. */
    policy: LockPolicy;
    /** Copies of the folder on machines HADAL reaches through its SSH hosts. */
    remote: RemoteLock[];
}

/** A host name, as `hosts.ts` accepts one. */
const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** A remote path, normalized, or undefined when it is not an absolute POSIX path. */
export function remotePath(path: string): string | undefined {
    if (
        typeof path !== "string" ||
        path === "" ||
        path.includes("\u0000") ||
        !path.startsWith("/")
    ) {
        return undefined;
    }

    const normalized = posix.normalize(path).replace(/\/+$/, "");

    return normalized === "" ? "/" : normalized;
}

/** Whether a remote path is `root` or inside it. Both are normalized POSIX paths. */
export function withinRemote(path: string, root: string): boolean {
    const inner = remotePath(path);
    const outer = remotePath(root);

    if (inner === undefined || outer === undefined) {
        return false;
    }

    return inner === outer || inner.startsWith(outer === "/" ? "/" : `${outer}/`);
}

/** Remote copies from stored or posted JSON, checked; undefined when one is not valid. */
export function parseRemoteLocks(value: unknown): RemoteLock[] | undefined {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value) || value.length > 8) {
        return undefined;
    }

    const out: RemoteLock[] = [];

    for (const raw of value) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            return undefined;
        }

        const host = (raw as { host?: unknown }).host;
        const path = (raw as { path?: unknown }).path;
        const normalized = typeof path === "string" ? remotePath(path) : undefined;

        if (typeof host !== "string" || !HOST_NAME.test(host) || normalized === undefined) {
            return undefined;
        }

        if (!out.some((each) => each.host === host && each.path === normalized)) {
            out.push({ host, path: normalized });
        }
    }

    return out;
}

/** A remote copy copied, so a caller cannot change stored state through the copy it got. */
function cloneRemote(remote: readonly RemoteLock[]): RemoteLock[] {
    return remote.map((each) => ({ host: each.host, path: each.path }));
}

/** A session that may not send to every model: the policy it is sealed to, and the folder that sealed it. */
export interface SealedPolicy {
    policy: LockPolicy;
    path?: string;
}

/** A sealed session, as the file keeps it. */
interface SealedEntry {
    policy: LockPolicy;
    path?: string;
    at: number;
}

/** The file as version 2 writes it: a policy on every lock and every seal. */
type SavedV2 = {
    version: 2;
    locks: FolderLock[];
    sealed: (SealedEntry & { id: number })[];
};

/** A policy copied, so a caller cannot change stored state through the copy it got. */
function clonePolicy(policy: LockPolicy): LockPolicy {
    return policy.scope === "custom"
        ? { scope: "custom", companies: [...policy.companies] }
        : { scope: policy.scope };
}

/** The company names a policy allows. `undefined` means every US company. */
function companiesOf(policy: LockPolicy): readonly string[] | undefined {
    switch (policy.scope) {
        case "local":
            return [];
        case "anthropic":
            return ["Anthropic"];
        case "us":
            return undefined;
        case "custom":
            return policy.companies;
    }
}

/** The policy for a set of company names, with the narrowest name for it. */
function policyOf(companies: readonly string[]): LockPolicy {
    const unique = [...new Set(companies)];

    if (unique.length === 0) {
        return { scope: "local" };
    }

    if (unique.length === 1 && unique[0] === "Anthropic") {
        return { scope: "anthropic" };
    }

    return { scope: "custom", companies: unique };
}

/** The narrower of two policies: the companies both allow. A seal never widens. */
export function stricterPolicy(a: LockPolicy, b: LockPolicy): LockPolicy {
    if (a.scope === "local" || b.scope === "local") {
        return { scope: "local" };
    }

    const left = companiesOf(a);
    const right = companiesOf(b);

    if (left === undefined && right === undefined) {
        return { scope: "us" };
    }

    if (left === undefined) {
        return policyOf(right!);
    }

    if (right === undefined) {
        return policyOf(left);
    }

    return policyOf(left.filter((company) => right.includes(company)));
}

/** Whether two policies allow the same models. */
function samePolicy(a: LockPolicy, b: LockPolicy): boolean {
    if (a.scope !== b.scope) {
        return false;
    }

    if (a.scope !== "custom" || b.scope !== "custom") {
        return true;
    }

    return (
        a.companies.length === b.companies.length &&
        a.companies.every((company) => b.companies.includes(company))
    );
}

/** A policy from the lock file, checked. An invalid policy fails closed. */
function savedPolicy(raw: unknown, path: string): LockPolicy {
    const policy = parsePolicy(raw);

    if (policy === undefined) {
        throw new Error(`the lock on ${path} has no valid policy`);
    }

    return policy;
}

/** Remote copies from the lock file, checked. An invalid copy fails closed. */
function savedRemote(raw: unknown, path: string): RemoteLock[] {
    const remote = parseRemoteLocks(raw);

    if (remote === undefined) {
        throw new Error(`the lock on ${path} has an invalid remote copy`);
    }

    return remote;
}

/** What a locked file fails with. */
export const LOCKED_PATH =
    "This folder is locked: only sessions working in it, under its model policy, can read it.";

// ─── Which models are local ─────────────────────────────────────────────────

/** An address on this machine, the LAN, link-local, or the tailnet (100.64/10, fd7a::/16). */
export function privateAddress(address: string): boolean {
    const kind = isIP(address);

    if (kind === 4) {
        const [a = -1, b = -1] = address.split(".").map(Number);

        return (
            a === 127 ||
            a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254)
        );
    }

    if (kind === 6) {
        const lower = address.toLowerCase();

        if (lower === "::1") {
            return true;
        }

        if (lower.startsWith("::ffff:")) {
            return privateAddress(lower.slice(7));
        }

        return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
    }

    return false;
}

/** The host of a model's address, without an IPv6 address's brackets, or undefined when it has none. */
export function hostOf(baseUrl: string | undefined): string | undefined {
    if (baseUrl === undefined || baseUrl === "") {
        return undefined;
    }

    try {
        const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");

        return host === "" ? undefined : host.toLowerCase();
    } catch {
        return undefined;
    }
}

/** How long a host's answer is trusted before it is looked up again: a name can move. */
const HOST_TTL_MS = 10 * 60_000;

/**
 * Whether a model is local: its address is on this machine, the LAN, or the tailnet. A name counts only when every
 * address it resolves to does, so a tailnet name that is a public Funnel does not. A model with no address, one that
 * does not resolve, and a provider's own API are not local.
 */
export class Locality {
    readonly #hosts = new Map<string, { local: boolean; at: number }>();
    readonly #resolve: (host: string) => Promise<string[]>;
    readonly #now: () => number;

    constructor(deps: { resolve?: (host: string) => Promise<string[]>; now?: () => number } = {}) {
        this.#resolve =
            deps.resolve ??
            (async (host) => (await lookup(host, { all: true })).map((entry) => entry.address));
        this.#now = deps.now ?? Date.now;
    }

    /** What is known now, without a lookup: undefined when the host's name must be looked up first. */
    known(model: { baseUrl?: string }): boolean | undefined {
        const host = hostOf(model.baseUrl);

        if (host === undefined) {
            return false;
        }

        if (isIP(host) !== 0) {
            return privateAddress(host);
        }

        if (host === "localhost" || host.endsWith(".localhost")) {
            return true;
        }

        const seen = this.#hosts.get(host);

        return seen !== undefined && this.#now() - seen.at < HOST_TTL_MS ? seen.local : undefined;
    }

    async check(model: { baseUrl?: string }): Promise<boolean> {
        const known = this.known(model);

        if (known !== undefined) {
            return known;
        }

        const host = hostOf(model.baseUrl)!;
        let local = false;

        try {
            const addresses = await this.#resolve(host);

            local = addresses.length > 0 && addresses.every(privateAddress);
        } catch {
            local = false;
        }

        this.#hosts.set(host, { local, at: this.#now() });

        return local;
    }
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/** A path as it really is: symlinks resolved as far as the path exists, the rest kept as written. */
export function canonical(path: string): string {
    let head = resolve(path);
    const rest: string[] = [];

    for (;;) {
        try {
            const real = realpathSync(head);

            return rest.length === 0 ? real : join(real, ...rest.reverse());
        } catch {
            const parent = dirname(head);

            if (parent === head) {
                return resolve(path);
            }

            rest.push(basename(head));
            head = parent;
        }
    }
}

/** Whether `path` is `root` or inside it. Both canonical. */
export function within(path: string, root: string): boolean {
    return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The folder a harness keeps a project's session logs in, under the names Pi, DSH, OMP and Claude Code give it. */
function harnessShadows(path: string, home: string): string[] {
    const dashed = path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
    const pi = `--${dashed}--`;
    const claude = path.replace(/[^A-Za-z0-9]/g, "-");

    return [
        join(home, ".pi", "agent", "sessions", pi),
        join(home, ".dsh", "sessions", pi),
        join(home, ".omp", "agent", "sessions", pi),
        join(home, ".claude", "projects", claude),
    ];
}

/** Where bubblewrap is, or undefined. */
function findBwrap(): string | undefined {
    for (const dir of [...(process.env.PATH ?? "").split(delimiter), "/usr/bin", "/bin"]) {
        if (dir !== "" && existsSync(join(dir, "bwrap"))) {
            return join(dir, "bwrap");
        }
    }

    return undefined;
}

/** How long `inside` keeps an answer. */
const INSIDE_TTL_MS = 5_000;

/** What HADAL keeps in its data folder that a blind session's commands may still use: the agent edits these. */
const DATA_KEPT = [
    "agents",
    "extensions",
    "gallery",
    "hq",
    "routers",
    "themes",
    "worktrees",
    "repos",
    "uploads",
];

// ─── The locks ──────────────────────────────────────────────────────────────

/** Whether a session's model passes a policy. */
export type Permits = (policy: LockPolicy) => boolean;

/** No policy passes: every locked folder and copy is hidden. */
export const PERMITS_NONE: Permits = () => false;

export class FolderLocks {
    readonly file: string;
    readonly dataDir: string;
    readonly #home: string;
    readonly #log: (message: string) => void;
    readonly #bwrap: string | undefined;
    #locks: FolderLock[] = [];
    /** Sealed sessions, and the policy each one may never widen. */
    #sealed = new Map<number, SealedEntry>();
    /** Locked folders and what counts as inside them (worktrees of a locked repository), canonical and as written. */
    #roots: string[] = [];
    /** Each root and the lock it belongs to, so a sealed session gets the policy of its own folder. */
    #rootPolicies: { root: string; lock: FolderLock }[] = [];
    /** Copies of locked folders kept elsewhere, and the policy that may see each: hidden, but not a place to work. */
    #hidden: { path: string; policy: LockPolicy }[] = [];
    /** The file could not be read: everything fails closed until it can. */
    #broken: string | undefined;
    #listeners = new Set<() => void>();
    #insideMemo = new Map<string, { inside: boolean; at: number }>();

    constructor(options: {
        dataDir: string;
        log?: (message: string) => void;
        home?: string;
        bwrap?: string | null;
    }) {
        this.dataDir = options.dataDir;
        this.file = join(options.dataDir, "folder-locks.json");
        this.#home = options.home ?? homedir();
        this.#log = options.log ?? (() => {});
        this.#bwrap = options.bwrap === null ? undefined : (options.bwrap ?? findBwrap());
        this.#load();
    }

    /** Whether anything is guarded: a lock, a sealed session, or a file that could not be read. */
    get guarding(): boolean {
        return this.#locks.length > 0 || this.#sealed.size > 0 || this.#broken !== undefined;
    }

    /** Whether a folder is locked: other sessions are blind to it. */
    get any(): boolean {
        return this.#locks.length > 0 || this.#broken !== undefined;
    }

    get broken(): string | undefined {
        return this.#broken;
    }

    /** Whether commands can be sandboxed here. */
    get sandboxed(): boolean {
        return this.#bwrap !== undefined;
    }

    list(): FolderLock[] {
        return this.#locks.map((lock) => ({
            ...lock,
            hide: [...lock.hide],
            policy: clonePolicy(lock.policy),
            remote: cloneRemote(lock.remote),
        }));
    }

    /** Told after every change. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /**
     * Whether a path is in a locked folder (or a worktree of one): a session there is sealed. Asked for session folders,
     * many times a second by the session list, so an answer is kept for a few seconds (`INSIDE_TTL_MS`). File tools ask
     * `blocked`, which keeps nothing: a symlink made a moment ago must count.
     */
    inside(path: string): boolean {
        if (this.#roots.length === 0) {
            return false;
        }

        const now = Date.now();
        const kept = this.#insideMemo.get(path);

        if (kept !== undefined && now - kept.at < INSIDE_TTL_MS) {
            return kept.inside;
        }

        const real = canonical(path);
        const literal = resolve(path);
        const inside = this.#roots.some((root) => within(real, root) || within(literal, root));

        this.#insideMemo.set(path, { inside, at: now });

        return inside;
    }

    /** The locked roots and hidden copies a model `permits` may not see. Without `permits`, all of them. */
    #forbidden(permits?: Permits): string[] {
        const roots =
            permits === undefined
                ? this.#roots
                : this.#rootPolicies
                      .filter((entry) => !permits(entry.lock.policy))
                      .map((entry) => entry.root);
        const hidden = this.#hidden
            .filter((entry) => permits === undefined || !permits(entry.policy))
            .map((entry) => entry.path);

        return [...roots, ...hidden];
    }

    /**
     * Whether a session must not touch a path: a locked folder, or a copy of one, whose policy does not allow the
     * session's model. Without `permits`, every locked folder and copy counts.
     */
    blocked(path: string, permits?: Permits): boolean {
        const forbidden = this.#forbidden(permits);

        if (forbidden.length === 0) {
            return false;
        }

        const real = canonical(path);
        const literal = resolve(path);

        return forbidden.some((root) => within(real, root) || within(literal, root));
    }

    /** Whether a model `permits` is kept out of anything: a lock, a copy, or a sealed session's data. */
    hides(permits: Permits): boolean {
        if (this.#broken !== undefined) {
            return true;
        }

        return (
            this.#locks.some((lock) => !permits(lock.policy)) ||
            [...this.#sealed.keys()].some((id) => {
                const sealed = this.policyForSealed(id);

                return sealed !== undefined && !permits(sealed.policy);
            })
        );
    }

    /** Whether a path holds a locked folder or a copy of one: removing or moving it would take the folder along. */
    holds(path: string, permits?: Permits): boolean {
        const real = canonical(path);

        return this.#forbidden(permits).some((root) => within(root, real));
    }

    isSealed(conversationId: number): boolean {
        return this.policyForSealed(conversationId) !== undefined;
    }

    /**
     * The policy a sealed session may never widen, and the folder that sealed it. A seal whose lock is gone has no
     * effect: the owner unlocked the folder. A seal with no folder (version 1 of the file) stays.
     */
    policyForSealed(conversationId: number): SealedPolicy | undefined {
        const entry = this.#sealed.get(conversationId);

        return entry === undefined ||
            (entry.path !== undefined && this.lockFor(entry.path) === undefined)
            ? undefined
            : {
                  policy: clonePolicy(entry.policy),
                  ...(entry.path === undefined ? {} : { path: entry.path }),
              };
    }

    /**
     * Seal a conversation: its requests go only to models the policy allows from now on. A second seal with a narrower
     * policy narrows it; one with a wider policy changes nothing.
     */
    seal(conversationId: number, policy: LockPolicy = { scope: "local" }, path?: string): void {
        const existing = this.#sealed.get(conversationId);
        const next =
            existing === undefined ? clonePolicy(policy) : stricterPolicy(existing.policy, policy);

        if (existing !== undefined && samePolicy(existing.policy, next)) {
            return;
        }

        const sealedPath = existing?.path ?? path;

        this.#sealed.set(conversationId, {
            policy: next,
            at: existing?.at ?? Date.now(),
            ...(sealedPath === undefined ? {} : { path: sealedPath }),
        });
        this.#recompute();
        this.#save();
        this.#log(`folder lock: session ${conversationId} sealed to ${describePolicy(next)}`);
    }

    /** Lock a folder. Its sessions are sealed by the app (`PocketApp.lockFolder`). */
    lock(
        path: string,
        hide: readonly string[] = [],
        by?: string,
        policy: LockPolicy = { scope: "local" },
        remote: readonly RemoteLock[] = [],
    ): FolderLock {
        if (!isAbsolute(path)) {
            throw new Error("A locked folder needs an absolute path.");
        }

        const folder = normalize(path).replace(/[/\\]+$/, "") || sep;

        if (folder === sep || canonical(folder) === canonical(this.#home)) {
            throw new Error(
                "The root and home folders cannot be locked: every session works under them.",
            );
        }

        if (
            within(canonical(this.dataDir), canonical(folder)) ||
            within(canonical(folder), canonical(this.dataDir))
        ) {
            throw new Error(
                "HADAL's own data folder, and folders in or above it, cannot be locked.",
            );
        }

        const extra = [
            ...new Set(hide.filter((each) => isAbsolute(each)).map((each) => normalize(each))),
        ];
        const existing = this.#locks.find((lock) => canonical(lock.path) === canonical(folder));

        if (existing !== undefined) {
            existing.hide = [...new Set([...existing.hide, ...extra])];
            existing.policy = clonePolicy(policy);
            existing.remote = cloneRemote(remote);
        } else {
            this.#locks.push({
                path: folder,
                hide: extra,
                at: Date.now(),
                ...(by === undefined ? {} : { by }),
                policy: clonePolicy(policy),
                remote: cloneRemote(remote),
            });
        }

        this.#recompute();
        this.#save();
        this.#log(`folder lock: ${folder} locked to ${describePolicy(policy)}`);

        return this.list().find((lock) => canonical(lock.path) === canonical(folder))!;
    }

    /** Change a lock's policy. Sessions already sealed keep the narrower policy they have. */
    setPolicy(path: string, policy: LockPolicy): FolderLock | undefined {
        const lock = this.#locks.find((each) => canonical(each.path) === canonical(path));

        if (lock === undefined) {
            return undefined;
        }

        lock.policy = clonePolicy(policy);
        this.#recompute();
        this.#save();
        this.#log(`folder lock: ${lock.path} now allows ${describePolicy(policy)}`);

        return this.list().find((each) => canonical(each.path) === canonical(path));
    }

    /** The lock that covers a folder: the deepest one. */
    lockFor(path: string): FolderLock | undefined {
        const real = canonical(path);
        const literal = resolve(path);
        let best: { root: string; lock: FolderLock } | undefined;

        for (const entry of this.#rootPolicies) {
            if (within(real, entry.root) || within(literal, entry.root)) {
                if (best === undefined || entry.root.length > best.root.length) {
                    best = entry;
                }
            }
        }

        return best?.lock;
    }

    /** The remote copies of locked folders on one host. */
    remoteLocks(host: string): { lock: FolderLock; path: string }[] {
        const out: { lock: FolderLock; path: string }[] = [];

        for (const lock of this.#locks) {
            for (const remote of lock.remote) {
                if (remote.host === host) {
                    out.push({ lock, path: remote.path });
                }
            }
        }

        return out;
    }

    /** The lock whose remote copy covers a path on a host, if one does. */
    lockForRemote(host: string, path: string): FolderLock | undefined {
        let best: { lock: FolderLock; path: string } | undefined;

        for (const entry of this.remoteLocks(host)) {
            if (
                withinRemote(path, entry.path) &&
                (best === undefined || entry.path.length > best.path.length)
            ) {
                best = entry;
            }
        }

        return best?.lock;
    }

    /** The policy that applies to a folder, or undefined when it is not locked. */
    policyFor(path: string): LockPolicy | undefined {
        return this.lockFor(path)?.policy;
    }

    /** Unlock a folder. Seals it gave stay on file, with no effect while no lock covers their folder. */
    unlock(path: string): boolean {
        const before = this.#locks.length;

        this.#locks = this.#locks.filter((lock) => canonical(lock.path) !== canonical(path));

        if (this.#locks.length === before) {
            return false;
        }

        this.#recompute();
        this.#save();
        this.#log(`folder lock: ${path} unlocked`);

        return true;
    }

    /** Find the copies of locked folders again: a worktree made since, a harness that logged a session since. */
    refresh(): void {
        this.#recompute();
    }

    /**
     * Bubblewrap's arguments for a command. Each locked folder whose policy `permits` does not pass is empty to it,
     * with its copies and the ways around a mount namespace. When the model passes every policy, only the lock file
     * is read-only.
     * `keep` names paths in the data folder the command itself writes (a background task's log).
     */
    sandboxArgs(options: {
        /** The policies the session's model passes. What another policy guards is empty to the command. */
        permits: Permits;
        cwd?: string;
        keep?: readonly string[];
        /** A background task outlives the server: it must not die with it. */
        detached?: boolean;
    }): string[] {
        // A user namespace of its own: besides the mounts, it keeps the command out of every other process's
        // `/proc/<pid>/root` and `environ`, whose view of the files is the machine's (measured on the VM, 2026-11-16).
        // The process ids stay shared, so a command started in the background with `&` outlives its shell as before.
        const args = ["--unshare-user", "--dev-bind", "/", "/"];

        if (options.detached !== true) {
            args.push("--die-with-parent");
        }

        const mask = (path: string) => {
            try {
                const stat = statSync(path);

                args.push(
                    ...(stat.isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]),
                );
            } catch {
                // Not there: nothing to hide.
            }
        };

        if (this.hides(options.permits)) {
            mask(this.dataDir);

            for (const name of DATA_KEPT) {
                const kept = join(this.dataDir, name);

                if (existsSync(kept)) {
                    args.push("--bind", kept, kept);
                }
            }

            for (const kept of options.keep ?? []) {
                if (existsSync(kept)) {
                    args.push("--bind", kept, kept);
                }
            }

            const uid = userInfo().uid;

            mask(join(this.#home, ".ssh"));
            mask(`/run/user/${uid}`);
            mask(`/tmp/tmux-${uid}`);
            mask(`/run/screen/S-${userInfo().username}`);

            for (const root of new Set(this.#forbidden(options.permits))) {
                mask(root);
            }

            args.push("--unsetenv", "SSH_AUTH_SOCK", "--unsetenv", "DBUS_SESSION_BUS_ADDRESS");
            args.push("--unsetenv", "TMUX", "--unsetenv", "XDG_RUNTIME_DIR");
        } else if (existsSync(this.file)) {
            args.push("--ro-bind", this.file, this.file);
        }

        if (options.cwd !== undefined && isAbsolute(options.cwd)) {
            args.push("--chdir", options.cwd);
        }

        return args;
    }

    /** Bubblewrap's path. */
    get bwrap(): string | undefined {
        return this.#bwrap;
    }

    // ─── State ──────────────────────────────────────────────────────────────

    #load(): void {
        let text: string;

        try {
            text = readFileSync(this.file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                this.#broken = `folder-locks.json cannot be read: ${(error as Error).message}`;
                this.#log(
                    `folder lock: ${this.#broken}; requests to models that are not local fail`,
                );
            }

            return;
        }

        try {
            const saved = JSON.parse(text) as {
                version?: unknown;
                locks?: unknown;
                sealed?: unknown;
            };

            if (
                (saved.version !== 1 && saved.version !== 2) ||
                !Array.isArray(saved.locks) ||
                !Array.isArray(saved.sealed)
            ) {
                throw new Error("not a version 1 or 2 lock file");
            }

            const rawLocks = saved.locks as (Partial<FolderLock> & { path: string })[];

            this.#locks = rawLocks
                .filter((lock) => typeof lock?.path === "string" && isAbsolute(lock.path))
                .map((lock) => {
                    const path = normalize(lock.path);

                    return {
                        path,
                        hide: Array.isArray(lock.hide)
                            ? lock.hide.filter(
                                  (each): each is string =>
                                      typeof each === "string" && isAbsolute(each),
                              )
                            : [],
                        at: typeof lock.at === "number" ? lock.at : 0,
                        ...(typeof lock.by === "string" ? { by: lock.by } : {}),
                        policy:
                            saved.version === 1
                                ? ({ scope: "local" } as const)
                                : savedPolicy(lock.policy, path),
                        remote: saved.version === 1 ? [] : savedRemote(lock.remote, path),
                    };
                });

            if (saved.version === 1) {
                this.#sealed = new Map(
                    saved.sealed
                        .filter((id): id is number => Number.isInteger(id))
                        .map((id) => [id, { policy: { scope: "local" }, at: 0 }]),
                );
            } else {
                this.#sealed = new Map(
                    (saved.sealed as unknown[]).map((raw) => {
                        const entry = raw as {
                            id?: unknown;
                            policy?: unknown;
                            path?: unknown;
                            at?: unknown;
                        };
                        const id = Number(entry.id);
                        const policy = parsePolicy(entry.policy);

                        if (!Number.isInteger(id) || policy === undefined) {
                            throw new Error("a sealed session has no valid policy");
                        }

                        return [
                            id,
                            {
                                policy,
                                at: typeof entry.at === "number" ? entry.at : 0,
                                ...(typeof entry.path === "string" ? { path: entry.path } : {}),
                            },
                        ];
                    }),
                );
            }

            this.#recompute();
        } catch (error) {
            this.#broken = `folder-locks.json is not valid: ${(error as Error).message}`;
            this.#log(`folder lock: ${this.#broken}; requests to models that are not local fail`);
        }
    }

    #save(): void {
        if (this.#broken !== undefined) {
            throw new Error(`${this.#broken}. Fix or remove the file, then restart HADAL.`);
        }

        const saved: SavedV2 = {
            version: 2,
            locks: this.#locks.map((lock) => ({
                ...lock,
                hide: [...lock.hide],
                policy: clonePolicy(lock.policy),
            })),
            sealed: [...this.#sealed.entries()]
                .map(([id, entry]) => ({
                    id,
                    ...entry,
                    policy: clonePolicy(entry.policy),
                }))
                .sort((a, b) => a.id - b.id),
        };
        const temporary = `${this.file}.${process.pid}.tmp`;

        writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, this.file);

        for (const listener of this.#listeners) {
            listener();
        }
    }

    #recompute(): void {
        const roots = new Set<string>();
        const hidden = new Map<string, { path: string; policy: LockPolicy }>();

        const hide = (path: string, policy: LockPolicy) => {
            const kept = hidden.get(path);

            hidden.set(path, {
                path,
                policy: kept === undefined ? policy : stricterPolicy(kept.policy, policy),
            });
        };

        const rootPolicies = new Map<string, { root: string; lock: FolderLock }>();

        for (const lock of this.#locks) {
            for (const root of [resolve(lock.path), canonical(lock.path)]) {
                roots.add(root);
                rootPolicies.set(root, { root, lock });
            }

            for (const each of lock.hide) {
                hide(resolve(each), lock.policy);
                hide(canonical(each), lock.policy);
            }

            for (const shadow of harnessShadows(resolve(lock.path), this.#home)) {
                if (existsSync(shadow)) {
                    hide(shadow, lock.policy);
                }
            }
        }

        // A worktree of a locked repository is the folder under another name: a place to work, so it counts as inside.
        const worktrees = join(this.dataDir, "worktrees");

        for (const tree of listDirs(worktrees, 2)) {
            try {
                const dotGit = readFileSync(join(tree, ".git"), "utf8");
                const gitdir = /^gitdir:\s*(.+)$/m.exec(dotGit)?.[1]?.trim();
                const owner =
                    gitdir === undefined
                        ? undefined
                        : this.#locks.find((lock) =>
                              within(canonical(gitdir), canonical(lock.path)),
                          );

                if (gitdir !== undefined && owner !== undefined) {
                    roots.add(tree);
                    roots.add(canonical(tree));
                    rootPolicies.set(tree, { root: tree, lock: owner });
                    rootPolicies.set(canonical(tree), { root: canonical(tree), lock: owner });
                }
            } catch {
                // Not a worktree.
            }
        }

        this.#roots = [...roots];
        this.#rootPolicies = [...rootPolicies.values()];

        // After the roots: a seal counts only while its lock is there (`policyForSealed`).
        for (const id of this.#sealed.keys()) {
            const sealed = this.policyForSealed(id);

            if (sealed !== undefined) {
                hide(join(this.dataDir, "uploads", String(id)), sealed.policy);
            }
        }

        this.#hidden = [...hidden.values()];
        this.#insideMemo.clear();
    }
}

/** Directories under `root`, down to `depth` levels. */
function listDirs(root: string, depth: number): string[] {
    const out: string[] = [];

    try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                const path = join(root, entry.name);

                out.push(path);

                if (depth > 1) {
                    out.push(...listDirs(path, depth - 1));
                }
            }
        }
    } catch {
        // Not there.
    }

    return out;
}

// ─── Commands and files ─────────────────────────────────────────────────────

type Method = keyof ExecutionEnv;

/** File methods whose first argument is a path. */
const PATH_FIRST: readonly Method[] = [
    "readTextFile",
    "openTextLineReader",
    "readTextLines",
    "readBinaryFile",
    "openBinaryReader",
    "writeFile",
    "appendFile",
    "truncateFile",
    "flushFile",
    "fileInfo",
    "listDir",
    "openDirReader",
    "canonicalPath",
    "createDir",
];

/**
 * A conversation's environment with the locks in force. A lock keeps out models its policy does not allow: a session
 * whose model `permits` does not pass a lock's policy cannot read, write, list, or run a command that sees inside it.
 * A session whose model passes may work there, and `enter` is told, so the app can seal it to that lock's policy.
 * Without `permits`, the old rule: a session outside every locked folder passes none, one inside passes all.
 * With no lock and no sandbox needed, `base` itself.
 */
export function lockEnv(
    base: ExecutionEnv,
    locks: FolderLocks,
    cwd: () => string,
    permits?: () => Permits,
    enter?: (lock: FolderLock) => void,
): ExecutionEnv {
    const refused = (path: string) => err(new FileError("permission_denied", LOCKED_PATH, path));
    const absolute = (path: string) => (isAbsolute(path) ? path : resolve(base.cwd, path));
    const passes: () => Permits =
        permits ?? (() => (locks.inside(cwd()) ? () => true : PERMITS_NONE));

    /** Whether the path is closed to this session's model now; when open and locked, the session enters the lock. */
    const closed = (path: string): boolean => {
        if (locks.blocked(path, passes())) {
            return true;
        }

        const lock = enter === undefined ? undefined : locks.lockFor(path);

        if (lock !== undefined) {
            enter!(lock);
        }

        return false;
    };

    const exec: ExecutionEnv["exec"] = async (command, options, context) => {
        if (!locks.any) {
            return base.exec(command, options, context);
        }

        const where = options?.cwd ?? cwd();
        const now = passes();

        if (closed(where)) {
            return err(new ExecutionError("spawn_error", LOCKED_PATH));
        }

        if (locks.bwrap === undefined) {
            // No sandbox on this machine: a command could read a lock this model may not see, so it does not run.
            return locks.hides(now)
                ? err(
                      new ExecutionError(
                          "shell_unavailable",
                          "A folder is locked and bubblewrap (bwrap) is not installed, so commands cannot be kept out of it. Install bubblewrap, or pick a model every lock allows.",
                      ),
                  )
                : base.exec(command, options, context);
        }

        const argv = [
            locks.bwrap,
            ...locks.sandboxArgs({ permits: now, cwd: where }),
            ...(typeof command === "string" ? ["bash", "-c", command] : command),
        ];

        return base.exec(argv, options, context);
    };

    const guarded = new Map<PropertyKey, unknown>([["exec", exec]]);

    for (const method of PATH_FIRST) {
        guarded.set(method, async (path: string, ...rest: unknown[]) => {
            if (!locks.any) {
                return (base[method] as (...args: unknown[]) => unknown).call(base, path, ...rest);
            }

            if (closed(absolute(path))) {
                return refused(absolute(path));
            }

            const result = (await (base[method] as (...args: unknown[]) => unknown).call(
                base,
                path,
                ...rest,
            )) as { ok: boolean; value?: { close?: (context: unknown) => Promise<void> } };

            // Asked again after: a symlink swapped in while the call ran does not hand over what it points to.
            if (closed(absolute(path))) {
                if (result.ok && typeof result.value?.close === "function") {
                    await result.value.close(rest.at(-1)).catch(() => {});
                }

                return refused(absolute(path));
            }

            return result;
        });
    }

    guarded.set("exists", async (path: string, context: unknown) => {
        if (locks.any && closed(absolute(path))) {
            return ok(false);
        }

        return base.exists(path, context as never);
    });

    guarded.set("remove", async (path: string, options: unknown, context: unknown) => {
        if (locks.any && (closed(absolute(path)) || locks.holds(absolute(path), passes()))) {
            return refused(absolute(path));
        }

        return base.remove(path, options as never, context as never);
    });

    guarded.set("renameFile", async (from: string, to: string, context: unknown) => {
        if (
            locks.any &&
            (closed(absolute(from)) ||
                locks.holds(absolute(from), passes()) ||
                closed(absolute(to)))
        ) {
            return refused(absolute(locks.blocked(absolute(to), passes()) ? to : from));
        }

        return base.renameFile(from, to, context as never);
    });

    // Only where the base has it: callers ask whether it is there.
    if (base.listFiles !== undefined) {
        const listFiles = base.listFiles.bind(base);

        guarded.set("listFiles", async (path: string, options: unknown, context: unknown) => {
            if (locks.any && closed(absolute(path))) {
                return refused(absolute(path));
            }

            const listed = await listFiles(path, options as never, context as never);

            if (!listed.ok || !locks.any) {
                return listed;
            }

            const root = absolute(path);
            const now = passes();

            return ok({
                ...listed.value,
                entries: listed.value.entries.filter(
                    (entry) =>
                        !locks.blocked(
                            isAbsolute(entry.path) ? entry.path : join(root, entry.path),
                            now,
                        ),
                ),
            });
        });
    }

    guarded.set(
        "watch",
        async (targets: { path: string }[], onChange: unknown, context: unknown) => {
            const kept = locks.any
                ? targets.filter((target) => !locks.blocked(absolute(target.path), passes()))
                : targets;

            return base.watch(kept as never, onChange as never, context as never);
        },
    );

    return new Proxy(base, {
        get(target, property) {
            if (guarded.has(property)) {
                return guarded.get(property);
            }

            const value = Reflect.get(target, property, target) as unknown;

            return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
        },
    });
}

// ─── Requests ───────────────────────────────────────────────────────────────

/** Whether a request from a provider session id must stay local, and why. */
export type LockVerdict = (sessionId: string) => Promise<SealedPolicy | undefined>;

/** The words a sealed session's blocked request fails with. */
function refusalText(model: Model<Api>, origin: ModelOrigin, sealed: SealedPolicy): string {
    const where =
        sealed.path === undefined
            ? "This session is sealed"
            : `This session's folder ${sealed.path} is locked`;

    return `${model.provider}/${model.id}: ${origin.reason}. ${where} to ${describePolicy(sealed.policy)}. Pick a model that policy allows.`;
}

type Streams = {
    streamSimple: (
        model: Model<Api>,
        context: never,
        options?: never,
    ) => AssistantMessageEventStream;
    stream: (model: Model<Api>, context: never, options?: never) => AssistantMessageEventStream;
};

function refusal(model: Model<Api>, message: string): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: message,
        timestamp: Date.now(),
    };
}

/**
 * Refuse a sealed session's requests to models that are not local, before anything is sent. Wraps `streamSimple`
 * and `stream` in place; install it first, so it is closest to the wire and every other wrapper's request (a
 * replay, a retry, a route to another model) passes it. A local model, or nothing guarded, goes straight through.
 */
export function installLockGate(
    models: Streams,
    locks: FolderLocks,
    locality: Locality,
    sealedSession: LockVerdict,
): void {
    for (const name of ["streamSimple", "stream"] as const) {
        const underlying = models[name].bind(models);

        models[name] = (model, context, options) => {
            if (!locks.guarding || locality.known(model) === true) {
                return underlying(model, context, options);
            }

            const out = createAssistantMessageEventStream();

            const fail = (message: string) => {
                const failed = refusal(model, message);

                out.push({ type: "error", reason: "error", error: failed });
                out.end(failed);
            };

            void (async () => {
                if (!(await locality.check(model))) {
                    const sessionId = (options as { sessionId?: string } | undefined)?.sessionId;

                    if (locks.broken !== undefined) {
                        return fail(
                            `${locks.broken}. Requests to models that are not local fail until it is fixed.`,
                        );
                    }

                    // A request no conversation owns cannot be shown not to carry a sealed session's words: while
                    // anything is guarded, it fails closed. Every request a run, a title, or a summary sends has one.
                    if (sessionId === undefined) {
                        return fail(
                            "A folder is locked, and this request to a model that is not local names no session, so it cannot be shown to be safe. Use a local model for it.",
                        );
                    }

                    const sealed = await sealedSession(sessionId);

                    if (sealed !== undefined) {
                        const origin = classify({
                            provider: model.provider,
                            id: model.id,
                            local: false,
                        });

                        if (!allows(sealed.policy, origin)) {
                            return fail(refusalText(model, origin, sealed));
                        }
                    }
                }

                const answer = underlying(model, context, options);

                for await (const event of answer) {
                    out.push(event);
                }

                out.end(await answer.result());
            })().catch((error: unknown) => fail(String(error)));

            return out;
        };
    }
}

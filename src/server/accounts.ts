/**
 * Named accounts of a provider: beside each provider's default sign-in (its entry in the shared sign-in file, the
 * one HADAL's terminal also signs in with), the owner keeps named accounts of its own, such as a second Anthropic
 * subscription (Max and Pro) or a second key of any provider. One account is active at a time, and every model of
 * the provider runs on the active account's sign-in. A switch takes effect from the next request a run makes; a
 * request already sent out keeps the account it went out with.
 *
 * The named accounts live in the data folder (accounts.json), not in the shared file: the terminal knows one
 * sign-in per provider, and the default account always is its one. The credential store HADAL's model runtime
 * uses wraps the shared file with this store (AccountCredentialStore), so a switch changes what the runtime
 * signs in with without touching the file.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** The account the shared sign-in file holds: one per provider, the one a terminal sign-in goes to. */
export const DEFAULT_ACCOUNT = "default";

/** One named account: what its sign-in says, in words, and the sign-in itself. */
export interface NamedAccount {
    name: string;
    credential: Credential;
}

export interface ProviderAccounts {
    /** DEFAULT_ACCOUNT, or a named account's id. */
    active: string;
    accounts: Record<string, NamedAccount>;
}

type AccountsFile = Record<string, ProviderAccounts>;

/** A named account as people see it. */
export interface AccountSummary {
    id: string;
    name: string;
    active: boolean;
    type: "api_key" | "oauth" | undefined;
    named: boolean;
}

const NAME_MAX = 40;

/** The data folder's accounts file, kept in memory and written back on each change. One server writes it. */
export class AccountStore {
    readonly #path: string;
    #data: AccountsFile;

    constructor(path: string) {
        this.#path = path;
        this.#data = this.#load();
    }

    #load(): AccountsFile {
        if (!existsSync(this.#path)) {
            return {};
        }

        try {
            const parsed = JSON.parse(readFileSync(this.#path, "utf-8")) as AccountsFile;

            return typeof parsed === "object" && parsed !== null ? parsed : {};
        } catch {
            return {};
        }
    }

    #save(): void {
        mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
        const tmp = `${this.#path}.${process.pid}.tmp`;

        writeFileSync(tmp, JSON.stringify(this.#data, undefined, 2) + "\n", {
            encoding: "utf-8",
            mode: 0o600,
        });
        renameSync(tmp, this.#path);
    }

    /** Its entries, for the credential store's list. */
    entries(): Iterable<[string, ProviderAccounts]> {
        return Object.entries(this.#data);
    }

    /** Its named accounts by provider; none when the provider has none. */
    entry(providerId: string): ProviderAccounts | undefined {
        return this.#data[providerId];
    }

    /** Whether the provider has more than its default account. */
    hasNamed(providerId: string): boolean {
        const entry = this.#data[providerId];

        return entry !== undefined && Object.keys(entry.accounts).length > 0;
    }

    /** The active account: the named one in force, or the default. */
    activeOf(providerId: string): { id: string; name: string } {
        const entry = this.#data[providerId];

        if (entry !== undefined) {
            const named = entry.accounts[entry.active];

            if (named !== undefined) {
                return { id: entry.active, name: named.name };
            }
        }

        return { id: DEFAULT_ACCOUNT, name: "Default" };
    }

    /** What the providers sheet shows for a provider's accounts: the default first, then the named ones. */
    accountsOf(providerId: string): AccountSummary[] {
        const active = this.activeOf(providerId).id;
        const entry = this.#data[providerId];

        return [
            {
                id: DEFAULT_ACCOUNT,
                name: "Default",
                active: active === DEFAULT_ACCOUNT,
                type: undefined,
                named: false,
            },
            ...Object.entries(entry?.accounts ?? {}).map(([id, account]) => ({
                id,
                name: account.name,
                active: active === id,
                type: account.credential.type,
                named: true,
            })),
        ];
    }

    /** Add a named account. Its name must not be taken here, and it becomes active only when told. */
    add(providerId: string, name: string, credential: Credential, activate = false): string {
        const trimmed = name.trim();

        if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
            throw new Error(`An account name needs one to ${NAME_MAX} characters.`);
        }

        const entry = (this.#data[providerId] ??= { active: DEFAULT_ACCOUNT, accounts: {} });
        const id = randomUUID();

        entry.accounts[id] = { name: trimmed, credential: cloneCredential(credential) };

        if (activate) {
            entry.active = id;
        }

        this.#save();

        return id;
    }

    /** A named account goes; when it was the active one, the default account comes back. */
    remove(providerId: string, accountId: string): void {
        const entry = this.#data[providerId];

        if (entry === undefined || entry.accounts[accountId] === undefined) {
            throw new Error("No such account.");
        }

        delete entry.accounts[accountId];

        if (entry.active === accountId) {
            entry.active = DEFAULT_ACCOUNT;
        }

        if (Object.keys(entry.accounts).length === 0) {
            delete this.#data[providerId];
        }

        this.#save();
    }

    /** The active account becomes `accountId`: a named one, or the default. */
    setActive(providerId: string, accountId: string): void {
        const entry = this.#data[providerId];

        if (accountId !== DEFAULT_ACCOUNT && entry?.accounts[accountId] === undefined) {
            throw new Error("No such account.");
        }

        this.#data[providerId] ??= { active: DEFAULT_ACCOUNT, accounts: {} };
        this.#data[providerId].active = accountId;
        this.#save();
    }

    /** The named accounts' stored credentials, by provider: what the credential store serves when one is active. */
    credentialOf(providerId: string, accountId: string): Credential | undefined {
        return this.#data[providerId]?.accounts[accountId]?.credential;
    }

    /** Replace a named account's credential, as a renewed sign-in does. */
    replaceCredential(providerId: string, accountId: string, credential: Credential): void {
        const entry = this.#data[providerId];
        const account = entry?.accounts[accountId];

        if (account === undefined) {
            throw new Error("No such account.");
        }

        account.credential = cloneCredential(credential);
        this.#save();
    }
}

/** A copy, so the runtime's renewals write its own view back, not the one shared with this store. */
function cloneCredential(credential: Credential): Credential {
    return JSON.parse(JSON.stringify(credential)) as Credential;
}

/**
 * The credential store HADAL's model runtime uses: the shared sign-in file for the default account, and this
 * store's named account when one is active. Everything the runtime does to a sign-in (a renewal, a login)
 * reaches the active account, and a switch changes what the next request signs in with.
 */
export class AccountCredentialStore implements CredentialStore {
    readonly #base: CredentialStore;
    readonly #named: AccountStore;

    constructor(base: CredentialStore, named: AccountStore) {
        this.#base = base;
        this.#named = named;
    }

    /** What is active for the provider now: a named account's sign-in, or the shared file's. */
    #activeNamed(providerId: string): { id: string; credential: Credential } | undefined {
        const entry = this.#named.entry(providerId);

        if (entry === undefined || entry.active === DEFAULT_ACCOUNT) {
            return undefined;
        }

        const credential = entry.accounts[entry.active]?.credential;

        return credential === undefined ? undefined : { id: entry.active, credential };
    }

    /** The shared sign-in file's entry for the provider, as its default account: what a terminal signs in with. */
    async baseCredential(providerId: string): Promise<Credential | undefined> {
        return this.#base.read(providerId);
    }

    async read(providerId: string): Promise<Credential | undefined> {
        const active = this.#activeNamed(providerId);

        return active === undefined
            ? this.#base.read(providerId)
            : cloneCredential(active.credential);
    }

    async list(): Promise<readonly CredentialInfo[]> {
        const base = await this.#base.list();
        const named: CredentialInfo[] = [];

        for (const [providerId, entry] of this.#named.entries()) {
            for (const account of Object.values(entry.accounts)) {
                named.push({ providerId, type: account.credential.type });
            }
        }

        return [...base, ...named];
    }

    async modify(
        providerId: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
        const active = this.#activeNamed(providerId);

        if (active === undefined) {
            return this.#base.modify(providerId, fn);
        }

        const next = await fn(cloneCredential(active.credential));

        if (next === undefined) {
            return active.credential;
        }

        if (JSON.stringify(next) !== JSON.stringify(active.credential)) {
            this.#named.replaceCredential(providerId, active.id, next);
        }

        return next;
    }

    async delete(providerId: string): Promise<void> {
        const active = this.#activeNamed(providerId);

        if (active === undefined) {
            return this.#base.delete(providerId);
        }

        this.#named.remove(providerId, active.id);
    }
}

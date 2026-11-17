/**
 * Model providers: which ones HADAL knows, whether each is signed in, and sign-ins run from the app. A sign-in asks its
 * questions (an API key, a code, a choice) through the tabs of the person who started it. HADAL shares HADAL's own
 * sign-ins (`~/.pi/agent/auth.json`), which is also the default account of every provider: the owner keeps named
 * accounts of their own beside it (a second Anthropic subscription, a second key of any provider), and the active
 * one is the one the provider's models run on.
 *
 * A subscription's sign-in (OAuth) counts as signed in for as long as it is stored, even once it can no longer be
 * renewed. So each is asked afresh (the Providers sheet, a model Lantern or a subagent on another model is about to use, a
 * run that failed on it): one its provider refuses to renew is marked as needing sign-in, the model menu marks its
 * models, Lantern and subagents on other models refuse them, and the owner is told, until someone signs in again. A
 * session's own run, a subagent on its model, and titles are not checked first: they try the model, and a run that
 * fails on it marks it. A mark is of an account: switching the active account leaves the other account's mark, and
 * a limit one account hit is not the next account's.
 */
import { randomUUID } from "node:crypto";
import type { AuthPrompt, Credential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { DEFAULT_ACCOUNT } from "./accounts.ts";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { ModelRefresh } from "./model-refresh.ts";

/** How long asking a provider's sign-in afresh may take: a renewal's own limit is 15 seconds. */
const CHECK_MS = 20_000;

/**
 * What a provider's token endpoint says when it will not renew a sign-in (OAuth's error codes, or a 400 or 401 from
 * it), as opposed to a network, a proxy, or a server that failed on the way.
 */
const REFUSED =
    /invalid_grant|invalid_token|invalid_client|unauthorized_client|revoked|expired|reauth|sign in again|log ?in again|\b40[01]\b/i;

/** What a failed run says when its provider's sign-in could not be renewed (pi-ai's `ModelsError`), and whose. */
const RENEWAL_FAILED = /OAuth (?:refresh|auth derivation) failed for ([\w.-]+)/;

/** An error and its causes, as one line. */
function chain(error: unknown): string {
    const parts: string[] = [];
    let each: unknown = error;

    for (let depth = 0; each !== undefined && each !== null && depth < 5; depth++) {
        parts.push(each instanceof Error ? each.message : String(each));
        each = each instanceof Error ? each.cause : undefined;
    }

    return parts.join(": ").replace(/\s+/g, " ").slice(0, 300);
}

/** A network or TLS failure on the way, which says nothing about the sign-in (a certificate can be "expired" too). */
const ON_THE_WAY =
    /certificate|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timed? ?out|aborted/i;

/** Whether an error from asking a sign-in means the provider refused to renew it (not a network or timeout). */
export function renewalRefused(error: unknown): boolean {
    if (
        (error as { code?: unknown } | undefined)?.code !== "oauth" ||
        !(error instanceof Error) ||
        error.cause === undefined
    ) {
        return false;
    }

    const said = chain(error.cause);

    return REFUSED.test(said) && !ON_THE_WAY.test(said);
}

interface AuthFlow {
    id: string;
    userId: string;
    prompts: Map<
        string,
        { resolve: (value: string) => void; reject: (error: Error) => void; requiresKey: boolean }
    >;
    abort: AbortController;
}

export class Providers {
    readonly #app: PocketApp;
    readonly #flows = new Map<string, AuthFlow>();
    readonly modelRefresh: ModelRefresh;
    /** Providers whose sign-in could not be renewed, and what they said, by the account the mark is of. In memory: asked again after a restart. */
    #expired = new Map<string, string>();
    /** Checks under way, by provider, so asking twice at once asks once. */
    readonly #checking = new Map<string, Promise<string | undefined>>();
    /**
     * Each provider's sign-ins and sign-outs here, counted: a check that began before one does not mark what it ended
     * (a sign-in that just worked would be marked as expired again).
     */
    readonly #signIns = new Map<string, number>();

    constructor(app: PocketApp) {
        this.#app = app;
        this.modelRefresh = new ModelRefresh(app);
    }

    /** The key a provider's account marks live under: the provider, and the account the mark is of. */
    #key(providerId: string, accountId?: string): string {
        const account = accountId ?? this.#app.accounts.activeOf(providerId).id;

        return `${providerId}\u0000${account}`;
    }

    /** How many sign-ins and sign-outs here a provider has had: a limit that one account hit is not the next one's. */
    signInEpoch(providerId: string): number {
        return this.#signIns.get(providerId) ?? 0;
    }

    /** Why the provider's active account needs a person to sign in again, as last asked; undefined when it does not. */
    needsSignIn(providerId: string): string | undefined {
        return this.#expired.get(this.#key(providerId));
    }

    /**
     * Ask a provider's sign-in afresh. A subscription's (OAuth) near its end is renewed, as a request would renew it;
     * one the provider refuses to renew is marked as needing sign-in, and one that works again is cleared. A network
     * that fails on the way changes nothing. Returns why it needs signing in, if it does.
     */
    check(providerId: string): Promise<string | undefined> {
        let pending = this.#checking.get(providerId);

        if (pending === undefined) {
            pending = this.#check(providerId).finally(() => this.#checking.delete(providerId));
            this.#checking.set(providerId, pending);
        }

        return pending;
    }

    async #check(providerId: string): Promise<string | undefined> {
        const models = this.#app.models;
        const began = this.#signIns.get(providerId) ?? 0;
        // The account being asked is the one active when the check began: a switch meanwhile starts a fresh check.
        const account = this.#app.accounts.activeOf(providerId).id;

        if (!models.isUsingOAuth(providerId)) {
            this.#clearKey(this.#key(providerId, account));

            return undefined;
        }

        try {
            await models.getAuth(providerId, { signal: AbortSignal.timeout(CHECK_MS) });
            this.#clearKey(this.#key(providerId, account));
        } catch (error) {
            if (renewalRefused(error) && (this.#signIns.get(providerId) ?? 0) === began) {
                this.#mark(providerId, account, chain((error as Error).cause));
            }
        }

        return this.#expired.get(this.#key(providerId, account));
    }

    /**
     * Ask every subscription's sign-in afresh, as the Providers sheet opens, waiting `waitMs` at most: a renewal can take
     * seconds, and a mark found later reaches the sheet with the models it marks.
     */
    async checkAll(waitMs = CHECK_MS): Promise<void> {
        const models = this.#app.models;
        const checks = Promise.all(
            models
                .getProviders()
                .filter((provider) => models.isUsingOAuth(provider.id))
                .map((provider) => this.check(provider.id).catch(() => undefined)),
        );
        let timer: NodeJS.Timeout | undefined;

        await Promise.race([
            checks,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, waitMs);
            }),
        ]).finally(() => clearTimeout(timer));
    }

    /** A run failed with `detail`: when its provider's sign-in could not be renewed, ask it, to mark it. */
    runFailed(detail: unknown): void {
        const provider = typeof detail === "string" ? RENEWAL_FAILED.exec(detail)?.[1] : undefined;

        if (provider !== undefined && this.#app.models.getProvider(provider) !== undefined) {
            void this.check(provider).catch(() => {});
        }
    }

    /** A run was answered by a provider's model: when its active account was marked, ask it again, which clears a mark that is stale. */
    runAnswered(providerId: string): void {
        if (this.#expired.has(this.#key(providerId))) {
            void this.check(providerId).catch(() => {});
        }
    }

    /**
     * Why HADAL may not use a model now, in words for HADAL to pass on: it is not known here, its provider is not signed in,
     * or the account it runs on expired. `fresh` asks the provider's sign-in again first. Undefined when it may be used.
     */
    async problem(ref: ModelRef, fresh = false): Promise<string | undefined> {
        const models = this.#app.models;
        const name = models.getProvider(ref.provider)?.name ?? ref.provider;
        const account = this.#app.accounts.activeOf(ref.provider);
        const whom = account.id === DEFAULT_ACCOUNT ? "" : ` (account ${account.name})`;

        if (models.getModel(ref.provider, ref.modelId) === undefined) {
            return `${ref.provider}/${ref.modelId} is not a model known here`;
        }

        if (!models.hasConfiguredAuth(ref.provider)) {
            return `${name} is not signed in`;
        }

        const expired = fresh ? await this.check(ref.provider) : this.needsSignIn(ref.provider);

        return expired === undefined
            ? undefined
            : `the sign-in to ${name}${whom} expired and could not be renewed: a person must sign in again (Providers)`;
    }

    #mark(providerId: string, accountId: string, why: string): void {
        const key = this.#key(providerId, accountId);
        const known = this.#expired.has(key);

        this.#expired.set(key, why);

        if (!known) {
            const name = this.#app.models.getProvider(providerId)?.name ?? providerId;
            const account = this.#app.accounts.activeOf(providerId);
            const whose = account.id === DEFAULT_ACCOUNT ? "" : ` (account ${account.name})`;

            // The owner's to fix: only they sign in.
            this.#app.ownerNotice(
                "warning",
                `The sign-in to ${name}${whose} expired and could not be renewed. Sign in again in Providers; until then sessions on its models fail, and Lantern and subagents on other models do not use them.`,
            );
            this.#changed();
        }
    }

    #clearKey(key: string): void {
        if (this.#expired.delete(key)) {
            this.#changed();
        }
    }

    /** A sign-in, sign-out, or account switch here: no mark of the provider's accounts stays, and a check under way leaves none. */
    #signedInOrOut(
        providerId: string,
        accountId?: string,
        resetLimits = true,
        clearMarks = true,
    ): void {
        this.#signIns.set(providerId, (this.#signIns.get(providerId) ?? 0) + 1);

        if (clearMarks) {
            if (accountId === undefined) {
                for (const key of [...this.#expired.keys()]) {
                    if (key.startsWith(`${providerId}\u0000`)) {
                        this.#expired.delete(key);
                    }
                }
            } else {
                this.#expired.delete(this.#key(providerId, accountId));
            }
        }

        // What a gate knew of a limit was about an account the provider does not run on any more.
        if (resetLimits) {
            this.#app.limits.reset(providerId);
        }
    }

    /** A mark came or went: tabs get the models marked again, and sessions' views their model's state. */
    #changed(): void {
        void this.#sendModels().catch((error: unknown) =>
            this.#app.log(`Models not sent: ${describe(error)}`),
        );
        this.#app.refreshViews();
    }

    /** Every provider and its sign-in, with its accounts when it keeps more than the default one. What a provider said when it refused to renew one is for the `owner` only. */
    async list(owner = false) {
        const models = this.#app.models;

        return Promise.all(
            models.getProviders().map(async (provider) => {
                const status = models.getProviderAuthStatus(provider.id);
                const expired = this.#expired.get(this.#key(provider.id));
                const auth = (
                    provider as {
                        auth?: { apiKey?: unknown; oauth?: { name?: string; loginLabel?: string } };
                    }
                ).auth;
                const catalog = models.getModels(provider.id);
                const accounts = this.#app.accounts.accountsOf(provider.id);
                const multiple = accounts.length > 1;
                // The default account's sign-in is the shared file's; its kind is what the file holds.
                const defaultType = await this.#defaultAccountType(provider.id);

                return {
                    id: provider.id,
                    name: provider.name,
                    configured: status.configured,
                    source: status.source ?? null,
                    label: status.label ?? null,
                    apiKey: auth?.apiKey !== undefined,
                    oauth:
                        auth?.oauth === undefined
                            ? null
                            : (auth.oauth.loginLabel ?? auth.oauth.name ?? "Subscription"),
                    models: catalog.length,
                    // The models the pickers offer (`shown` of `models`); the owner narrows them from the sheet.
                    shown: catalog.filter((model) =>
                        this.#app.config.showsModel(provider.id, model.id),
                    ).length,
                    // The account the provider runs on: shown when it keeps more than the default one.
                    ...(multiple ? { account: this.#app.accounts.activeOf(provider.id) } : {}),
                    // The owner sees every account and what each needs; others only that one is in use.
                    ...(owner
                        ? {
                              accounts: accounts.map((each) => {
                                  const mark = this.#expired.get(this.#key(provider.id, each.id));

                                  return {
                                      ...each,
                                      // The default account's sign-in is the shared file's; its kind is what the file holds.
                                      type: each.named ? each.type : defaultType,
                                      ...(mark === undefined ? {} : { needsSignIn: mark }),
                                  };
                              }),
                          }
                        : {}),
                    ...(expired === undefined
                        ? {}
                        : { needsSignIn: owner ? expired : "its provider would not renew it" }),
                };
            }),
        );
    }

    /** What the shared sign-in file holds for a provider, as its default account: api_key or oauth. */
    async #defaultAccountType(providerId: string): Promise<"api_key" | "oauth" | undefined> {
        return (await this.#app.accountAuth.baseCredential(providerId))?.type;
    }

    /** A provider's whole catalog, by id, with whether the pickers offer each model. */
    modelsFor(providerId: string): { id: string; name: string; shown: boolean }[] {
        const provider = this.#provider(providerId);

        return this.#app.models
            .getModels(provider.id)
            .map((model) => ({
                id: model.id,
                name: model.name,
                shown: this.#app.config.showsModel(provider.id, model.id),
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * What a provider offers the pickers from now on. `models` are ids from its catalog, or null for every one of
     * them. Nothing else about a model changes. One that is not offered still runs in a session that has it, and
     * `/model` still takes it by name.
     */
    setVisible(providerId: string, models: readonly string[] | null): void {
        const provider = this.#provider(providerId);

        if (models !== null) {
            const known = new Set(this.#app.models.getModels(provider.id).map((each) => each.id));
            const unknown = models.find((id) => !known.has(id));

            if (unknown !== undefined) {
                throw new HttpError(400, `No such model: ${provider.id}/${unknown}`);
            }
        }

        this.#app.config.setVisibleModels(provider.id, models);
        this.#sendModels();
    }

    /** A provider the model runtime knows, by id. */
    #provider(id: string) {
        const provider = this.#app.models.getProviders().find((each) => each.id === id);

        if (provider === undefined) {
            throw new HttpError(404, "No such provider");
        }

        return provider;
    }

    startLogin(user: User, providerId: string, type: "api_key" | "oauth"): string {
        const app = this.#app;

        // An endpoint's key goes in its form, which keeps it to its address. A sign-in open here would
        // also hold HADAL's queue of the endpoint's sign-ins, and with it every endpoint save.
        if (app.customProviders.list().some((each) => each.id === providerId)) {
            throw new HttpError(400, "Change an endpoint's key with its Edit button.");
        }

        const flow: AuthFlow = {
            id: randomUUID(),
            userId: user.id,
            prompts: new Map(),
            abort: new AbortController(),
        };

        this.#flows.set(flow.id, flow);

        // Its name, as the Providers sheet shows it, for the dialog's title and the notice when it worked.
        const providerName = app.models.getProvider(providerId)?.name ?? providerId;

        const send = (data: Record<string, unknown>) => {
            for (const client of app.clients) {
                if (client.user.id === user.id) {
                    client.send("auth", { flowId: flow.id, providerId, providerName, ...data });
                }
            }
        };

        let lastPromptType: AuthPrompt["type"] | undefined;

        const interaction = {
            signal: flow.abort.signal,
            prompt: (prompt: AuthPrompt) =>
                new Promise<string>((resolvePrompt, rejectPrompt) => {
                    const promptId = randomUUID();

                    lastPromptType = prompt.type;
                    flow.prompts.set(promptId, {
                        resolve: resolvePrompt,
                        reject: rejectPrompt,
                        requiresKey: type === "api_key" && prompt.type === "secret",
                    });
                    const { signal, ...shown } = prompt;

                    signal?.addEventListener("abort", () => {
                        flow.prompts.delete(promptId);
                        send({ step: "prompt-closed", promptId });
                        rejectPrompt(new Error("cancelled"));
                    });
                    send({ step: "prompt", promptId, prompt: shown });
                }),
            notify: (event: unknown) => send({ step: "event", event }),
        };

        void this.#signIn(providerId, type, interaction)
            .then(
                () => send({ step: "done", ok: true }),
                (error: unknown) =>
                    send({
                        step: "done",
                        ok: false,
                        loginType: type,
                        error:
                            type === "oauth" && lastPromptType === "manual_code"
                                ? "That code was not accepted."
                                : "Sign-in did not finish. Try again.",
                        details: describe(error),
                    }),
            )
            .finally(() => this.#flows.delete(flow.id));

        return flow.id;
    }

    answerLogin(user: User, flowId: string, promptId: string, value: string | undefined): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            throw new HttpError(404, "No such login");
        }

        const prompt = flow.prompts.get(promptId);

        if (prompt === undefined) {
            throw new HttpError(404, "No such prompt");
        }

        if (prompt.requiresKey && value !== undefined && value.trim() === "") {
            throw new HttpError(400, "Enter an API key.");
        }

        flow.prompts.delete(promptId);

        if (value === undefined) {
            prompt.reject(new Error("cancelled"));
            flow.abort.abort();
        } else {
            prompt.resolve(value);
        }
    }

    /** Stop a sign-in its person gave up on, whether or not it is asking something. */
    cancelLogin(user: User, flowId: string): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            return;
        }

        for (const prompt of flow.prompts.values()) {
            prompt.reject(new Error("cancelled"));
        }

        flow.prompts.clear();
        flow.abort.abort();
    }

    /**
     * Sign in a new named account of the provider: its own sign-in asks its questions through the person's tabs, and
     * its answer is kept as the account. It is active at once only when it is the provider's first sign-in; one added
     * beside a sign-in in use waits for the owner to switch to it.
     */
    startAccountLogin(
        user: User,
        providerId: string,
        type: "api_key" | "oauth",
        name?: string,
    ): string {
        const app = this.#app;

        // An endpoint's key goes in its form, which keeps it to its address, and its sign-ins share its queue.
        if (app.customProviders.list().some((each) => each.id === providerId)) {
            throw new HttpError(400, "Change an endpoint's key with its Edit button.");
        }

        const provider = this.#provider(providerId);
        const method = type === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey;

        if (method?.login === undefined) {
            throw new HttpError(400, `${provider.name} does not support ${type} sign-ins.`);
        }

        // A sign-in that would be the provider's first becomes the account it runs on; one beside a sign-in in use does not.
        const firstSignIn =
            !app.models.hasConfiguredAuth(providerId) && !app.accounts.hasNamed(providerId);

        const flow: AuthFlow = {
            id: randomUUID(),
            userId: user.id,
            prompts: new Map(),
            abort: new AbortController(),
        };

        this.#flows.set(flow.id, flow);

        // Its name, as the Providers sheet shows it, for the dialog's title and the notice when it worked.
        const providerName = app.models.getProvider(providerId)?.name ?? providerId;

        const send = (data: Record<string, unknown>) => {
            for (const client of app.clients) {
                if (client.user.id === user.id) {
                    client.send("auth", { flowId: flow.id, providerId, providerName, ...data });
                }
            }
        };

        let lastPromptType: AuthPrompt["type"] | undefined;

        const interaction = {
            signal: flow.abort.signal,
            prompt: (prompt: AuthPrompt) =>
                new Promise<string>((resolvePrompt, rejectPrompt) => {
                    const promptId = randomUUID();

                    lastPromptType = prompt.type;
                    flow.prompts.set(promptId, {
                        resolve: resolvePrompt,
                        reject: rejectPrompt,
                        requiresKey: type === "api_key" && prompt.type === "secret",
                    });
                    const { signal, ...shown } = prompt;

                    signal?.addEventListener("abort", () => {
                        flow.prompts.delete(promptId);
                        send({ step: "prompt-closed", promptId });
                        rejectPrompt(new Error("cancelled"));
                    });
                    send({ step: "prompt", promptId, prompt: shown });
                }),
            notify: (event: unknown) => send({ step: "event", event }),
        };

        void this.#addAccount(providerId, type, interaction, name, firstSignIn)
            .then(
                () => send({ step: "done", ok: true }),
                (error: unknown) =>
                    send({
                        step: "done",
                        ok: false,
                        loginType: type,
                        error:
                            type === "oauth" && lastPromptType === "manual_code"
                                ? "That code was not accepted."
                                : "Sign-in did not finish. Try again.",
                        details: describe(error),
                    }),
            )
            .finally(() => this.#flows.delete(flow.id));

        return flow.id;
    }

    /** The sign-in's own questions, and when it works, the account it becomes. */
    async #addAccount(
        providerId: string,
        type: "api_key" | "oauth",
        interaction: ProviderAuthInteraction,
        name: string | undefined,
        firstSignIn: boolean,
    ): Promise<void> {
        const given = (name ?? "").trim();
        const accountName =
            given === ""
                ? (
                      await interaction.prompt({
                          type: "text",
                          message: "Name this account",
                          placeholder: "Max",
                      })
                  ).trim()
                : given;

        if (accountName.length === 0 || accountName.length > 40) {
            throw new Error("An account name needs one to 40 characters.");
        }

        const provider = this.#provider(providerId);
        let credential: Credential;

        if (type === "oauth") {
            const login = provider.auth?.oauth?.login;

            if (login === undefined) {
                throw new Error(`${provider.name} does not support oauth sign-ins.`);
            }

            credential = await login(interaction, {
                getDeviceId: () => this.#app.settings.getOrCreateDeviceId(),
            });
        } else {
            const login = provider.auth?.apiKey?.login;

            if (login === undefined) {
                throw new Error(`${provider.name} does not support api_key sign-ins.`);
            }

            credential = await login(interaction);
        }

        const newId = this.#app.accounts.add(providerId, accountName, credential, firstSignIn);

        await this.#app.models.getAvailable().catch(() => []);
        // Only the account just signed in is cleared of its mark; the others (and their limits) stay.
        this.#signedInOrOut(providerId, newId, firstSignIn, true);
        this.#changed();
    }

    /**
     * The provider runs on `accountId` from its next request: the default one, or a named one. A mark of another
     * account's sign-in stays its own, and a limit the provider hit stays with the account it hit it on. The runtime
     * learns of the switch at once: what it offers the pickers, and what it signs in with, is the account in use.
     */
    async setActiveAccount(providerId: string, accountId: string): Promise<void> {
        this.#provider(providerId);

        if (this.#app.accounts.activeOf(providerId).id === accountId) {
            return;
        }

        this.#app.accounts.setActive(providerId, accountId);
        // A switch changes what runs, but the marks of the accounts not switched to stay as they are.
        this.#signedInOrOut(providerId, undefined, true, false);
        await this.#app.models.getAvailable().catch(() => []);
        this.#changed();
        // Ask the account now in use afresh: a renewed sign-in that works again clears its mark.
        void this.check(providerId).catch(() => {});
    }

    /** A named account goes; when it was the one in use, the default account comes back. */
    async removeAccount(providerId: string, accountId: string): Promise<void> {
        this.#provider(providerId);

        if (accountId === DEFAULT_ACCOUNT) {
            throw new HttpError(
                400,
                "The default account is the shared sign-in: Log out removes it.",
            );
        }

        this.#app.accounts.remove(providerId, accountId);
        // The removed account's mark goes with it; the others stay.
        this.#signedInOrOut(providerId, accountId, true, true);
        await this.#app.models.getAvailable().catch(() => []);
        this.#changed();
        void this.check(providerId).catch(() => {});
    }

    /** Keep `key` as the provider's API-key sign-in, as the API key button does: an endpoint's key, say. */
    storeApiKey(providerId: string, key: string): Promise<void> {
        return this.#signIn(providerId, "api_key", {
            prompt: () => Promise.resolve(key),
            notify: () => {},
        });
    }

    /**
     * Put back the API key that a refused save took at sign-in count `epoch`, unless a sign-in or
     * sign-out came since or auth.json has a key again (Pi in a terminal). Checked in HADAL's own queue
     * of sign-ins, after those that came first.
     */
    async restoreApiKey(providerId: string, key: string, epoch: number): Promise<void> {
        let newer = false;

        await this.#signIn(providerId, "api_key", {
            prompt: async () => {
                newer =
                    this.signInEpoch(providerId) !== epoch ||
                    (await this.#app.models.listCredentials()).some(
                        (each) => each.providerId === providerId,
                    );

                if (newer) {
                    throw new Error("A newer sign-in came meanwhile.");
                }

                return key;
            },
            notify: () => {},
        }).catch((error: unknown) => {
            if (!newer) {
                throw error;
            }
        });
    }

    /** HADAL's sign-in, then what each sign-in here does: no mark or limit of the account before stays, and tabs know. */
    async #signIn(
        providerId: string,
        type: "api_key" | "oauth",
        interaction: Parameters<PocketApp["models"]["login"]>[2],
    ): Promise<void> {
        // Sign-ins that identify the installation (ChatGPT) get the ID HADAL keeps for it, the same as HADAL's own login.
        await this.#app.models.login(providerId, type, interaction, {
            getDeviceId: () => this.#app.settings.getOrCreateDeviceId(),
        });
        await this.#app.models.getAvailable().catch(() => []);
        this.#signedInOrOut(providerId, this.#app.accounts.activeOf(providerId).id);
        this.#changed();
    }

    async logout(providerId: string): Promise<void> {
        await this.#app.models.logout(providerId);
        await this.#app.models.getAvailable().catch(() => []);
        this.#signedInOrOut(providerId, this.#app.accounts.activeOf(providerId).id);
        this.#changed();
    }

    /** A manual catalog reload reached a new snapshot: every picker and session view gets it. */
    modelsChanged(): void {
        this.#changed();
    }

    /** Every tab gets the models available now, marked when their sign-in needs renewing. */
    async #sendModels(): Promise<void> {
        const models = await this.#app.modelList();

        for (const client of this.#app.clients) {
            client.send("models", models);
        }
    }

    close(): void {
        this.modelRefresh.close();

        for (const flow of this.#flows.values()) {
            flow.abort.abort();
        }
    }
}

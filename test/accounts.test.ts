// A provider's named accounts: the owner keeps a second sign-in beside the shared one (a second Anthropic
// subscription, a second key of any provider), switches which account the provider runs on, and the runtime
// signs in with the account in use. A renewal goes to the account it came from, a first sign-in becomes the
// account, and a removed or switched account leaves the others untouched, through a restart.
import { cleanUp, fakeTab, home, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Credential, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import type { App } from "./helpers.ts";

const { PocketApp } = await import("../src/server/app.ts");

const route: FauxResponseStep = () => fauxAssistantMessage([fauxText("ok")]);
const faux = scriptedModel(route);

/** What a renewal is asked of, in order: proof that the account asked was the one in use. */
const renewed: string[] = [];

/**
 * A subscription's auth. `loginAccess` is what a sign-in run here answers with: a second subscription, not
 * the shared file's one, so the tests can tell the accounts apart.
 */
function oauthFor(providerName: string, loginAccess: string) {
    return {
        name: providerName,
        login: async (_interaction: ProviderAuthInteraction): Promise<OAuthCredential> => ({
            type: "oauth",
            access: loginAccess,
            refresh: `refresh-of-${loginAccess}`,
            expires: Date.now() + 3_600_000,
        }),
        refresh: async (credential: OAuthCredential) => {
            renewed.push(credential.refresh);

            return {
                ...credential,
                access: `${credential.access}-renewed`,
                expires: Date.now() + 3_600_000,
            };
        },
        toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
    };
}

function keyFor(providerName: string) {
    return {
        name: `${providerName} key`,
        login: async (interaction: ProviderAuthInteraction): Promise<Credential> => ({
            type: "api_key",
            key: await interaction.prompt({
                type: "secret",
                message: "Key",
                placeholder: "sk-ant",
            }),
        }),
        resolve: async ({ credential }: { credential?: Credential }) =>
            credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } },
    };
}

/** A subscription provider: its default account (the shared file's) is a Max subscription. */
const base = fauxProvider({ provider: "expiring", models: [{ id: "exp-1" }] });
const expiring = {
    ...base.provider,
    name: "Expiring",
    auth: { oauth: oauthFor("Expiring", "pro-access"), apiKey: keyFor("Expiring") },
};

/** A provider with no sign-in at all, until the owner adds an account to it. */
const freshBase = fauxProvider({ provider: "fresh", models: [{ id: "fresh-1" }] });
const fresh = {
    ...freshBase.provider,
    name: "Fresh",
    auth: { oauth: oauthFor("Fresh", "pro-access") },
};

const dataDir = join(root, "accounts-data");
let app: App;
let server: ReturnType<typeof createServer>;
let baseUrl = "";

/** The shared sign-in file, as HADAL's terminal keeps it. */
function authFile(): string {
    return readFileSync(join(root, "agent", "auth.json"), "utf-8");
}

/** The data folder's accounts file. */
function accountsFile(): any {
    return JSON.parse(readFileSync(join(dataDir, "accounts.json"), "utf-8"));
}

before(async () => {
    // Expiring's default account: its Max subscription, in the shared file, still valid.
    const agent = join(root, "agent");

    mkdirSync(agent, { recursive: true });
    writeFileSync(
        join(agent, "auth.json"),
        JSON.stringify({
            expiring: {
                type: "oauth",
                access: "max-access",
                refresh: "refresh-of-max-access",
                expires: Date.now() + 3_600_000,
            },
        }),
    );

    app = await PocketApp.open({
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => {
            models.registerNativeProvider(faux.provider);
            models.registerNativeProvider(expiring as never);
            models.registerNativeProvider(fresh as never);
        },
    });

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

type AuthEvent = {
    flowId?: string;
    step?: string;
    ok?: boolean;
    error?: string;
    promptId?: string;
    prompt?: { type: string; message: string };
};

type Tab = ReturnType<typeof fakeTab>;

/** Answer every question a sign-in asks, until it is done: a name for a new account, a key for an API key. */
async function drive(tab: Tab, flowId: string): Promise<AuthEvent> {
    await until(async () => {
        const last = tab.last("auth") as AuthEvent | undefined;

        if (last?.flowId !== flowId) {
            return false;
        }

        if (last.step === "prompt" && last.prompt !== undefined) {
            app.providers.answerLogin(
                owner(app),
                flowId,
                last.promptId!,
                last.prompt.type === "secret" ? "sk-test" : "Max",
            );

            return false;
        }

        return last.step === "done";
    }, "the sign-in to finish");

    return tab.last("auth") as AuthEvent;
}

/** The owner's account for a provider, from the data folder's file, by name; the one in use, by id. */
function kept(providerId: string, by: { name?: string; id?: string }): any {
    const entry = accountsFile()[providerId];
    const accounts = Object.entries(entry?.accounts ?? {}) as [string, any][];

    return by.id
        ? accounts.find(([id]) => id === by.id)?.[1]
        : accounts.find(([, account]) => account.name === by.name)?.[1];
}

/** The provider's accounts as the sheet shows them, and which is in use. */
async function sheet(id: string, ownerView = false) {
    const list = await app.providers.list(ownerView);

    return list.find((provider: any) => provider.id === id) as any;
}

/** A request to the running server, signed in with `token` (or not), as the app's API sees it. */
async function call(token: string | null, path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data: any = text;

    try {
        data = JSON.parse(text);
    } catch {
        // Not JSON: an error page.
    }

    return { status: response.status, data };
}

const ownerToken = () => app.config.ownerToken;

test("a provider with no account of its own shows no account, and the default sign-in is the shared file's", async () => {
    assert.equal((await app.accountAuth.read("expiring"))?.type, "oauth");
    assert.match(authFile(), /max-access/);

    const { models } = await app.hello(owner(app));
    const exp1 = models.find((model) => model.provider === "expiring" && model.id === "exp-1");

    assert.ok(exp1, "the default sign-in's models are offered");
    assert.equal(exp1?.account, undefined, "no account is named");
    assert.equal(
        (await sheet("expiring", true)).account,
        undefined,
        "the sheet shows no account to switch",
    );
});

test("a sign-in beside the one in use adds an account that is not in use yet", async () => {
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);

    try {
        const flowId = app.providers.startAccountLogin(owner(app), "expiring", "oauth");
        const done = await drive(tab, flowId);

        assert.equal(done.ok, true, done.error ?? "the sign-in did not finish");

        const shown = await sheet("expiring", true);
        const account = shown.accounts.find((each: any) => each.name === "Max");

        assert.ok(account, "the account is in the sheet");
        assert.equal(account.active, false, "the one in use stays in use");
        assert.equal(shown.account.id, "default");

        // The runtime still signs in with the shared file's sign-in.
        const read = (await app.accountAuth.read("expiring")) as OAuthCredential;

        assert.equal(read.access, "max-access");
        assert.match(authFile(), /max-access/);

        // The new account is in the data folder's file, not in the shared one: a second subscription, a different sign-in.
        const asKept = kept("expiring", { id: account.id });

        assert.equal(asKept.credential.access, "pro-access");
        assert.doesNotMatch(authFile(), /pro-access/);
    } finally {
        app.detach(tab.client);
    }
});

test("the owner switches accounts, and the runtime signs in with the new one from the next request", async () => {
    const beforeEpoch = app.providers.signInEpoch("expiring");
    const shown = await sheet("expiring", true);
    const account = shown.accounts.find((each: any) => each.name === "Max");

    await app.providers.setActiveAccount("expiring", account.id);

    // The next request signs in with the account, not the shared file's sign-in.
    const read = (await app.accountAuth.read("expiring")) as OAuthCredential;

    assert.equal(read.access, "pro-access");
    assert.equal(read.refresh, "refresh-of-pro-access");

    // A limit the provider hit, and the provider's marks, are of the account it was hit on.
    assert.equal(app.providers.signInEpoch("expiring"), beforeEpoch + 1);
    assert.equal(app.accounts.activeOf("expiring").id, account.id);

    // The model list says which account the provider runs on.
    const { models } = await app.hello(owner(app));

    assert.equal(models.find((model) => model.provider === "expiring")?.account, "Max");
});

test("a renewal of the account in use is kept on that account, not in the shared file", async () => {
    const account = app.accounts.activeOf("expiring");

    // The account's sign-in runs out.
    const current = app.accounts.credentialOf("expiring", account.id) as OAuthCredential;

    app.accounts.replaceCredential("expiring", account.id, { ...current, expires: 0 });
    const sharedBefore = authFile();

    renewed.length = 0;

    await app.providers.check("expiring");

    // The renewal asked the account it came from, and its renewed sign-in is kept on that account.
    assert.deepEqual(renewed, [`refresh-of-${current.access}`]);
    const after = app.accounts.credentialOf("expiring", account.id) as OAuthCredential;

    assert.equal(after.access, `${current.access}-renewed`);
    assert.equal(authFile(), sharedBefore, "the shared file is untouched");

    // A working renewal leaves no mark.
    assert.equal(app.providers.needsSignIn("expiring"), undefined);

    // The kept renewal is in the data folder's file.
    assert.equal(kept("expiring", { id: account.id }).credential.access, after.access);
});

test("a first sign-in becomes the account the provider runs on", async () => {
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);

    try {
        const flowId = app.providers.startAccountLogin(owner(app), "fresh", "oauth");
        const done = await drive(tab, flowId);

        assert.equal(done.ok, true, done.error ?? "the sign-in did not finish");

        const active = app.accounts.activeOf("fresh");

        assert.notEqual(active.id, "default", "the first sign-in is in use at once");
        assert.equal(active.name, "Max");

        const read = (await app.accountAuth.read("fresh")) as OAuthCredential;

        assert.equal(read.access, "pro-access");

        const { models } = await app.hello(owner(app));

        assert.equal(models.find((model) => model.provider === "fresh")?.account, "Max");
    } finally {
        app.detach(tab.client);
    }
});

test("switching back to the default account brings its sign-in back", async () => {
    const namedId = app.accounts.activeOf("expiring").id;

    await app.providers.setActiveAccount("expiring", "default");

    const read = (await app.accountAuth.read("expiring")) as OAuthCredential;

    assert.equal(read.access, "max-access");
    assert.equal(app.accounts.activeOf("expiring").id, "default");

    // The named account is kept, whole, for a switch back.
    assert.equal(kept("expiring", { id: namedId }).credential.access, "pro-access-renewed");
});

test("a removed account leaves the default in use, and the default is not removable", async () => {
    const active = app.accounts.activeOf("fresh");

    assert.notEqual(active.id, "default", "the earlier test left an account in use");
    await app.providers.removeAccount("fresh", active.id);

    assert.equal(app.accounts.activeOf("fresh").id, "default");
    assert.equal(app.accounts.hasNamed("fresh"), false);

    await assert.rejects(app.providers.removeAccount("fresh", "default"), /shared sign-in/);
    await assert.rejects(
        app.providers.removeAccount("fresh", "no-such-account"),
        /No such account/,
    );
});

test("the owner's routes add, switch, and remove accounts; the list says which is in use", async () => {
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);

    try {
        // A new account by API key: the flow asks for the key, the account comes back.
        const added = await call(ownerToken(), "/api/providers/expiring/accounts", "POST", {
            type: "api_key",
            name: "Keys",
        });

        assert.equal(added.status, 200);
        const done = await drive(tab, added.data.flowId);

        assert.equal(done.ok, true, done.error ?? "the sign-in did not finish");

        const shown = await sheet("expiring", true);
        const account = shown.accounts.find((each: any) => each.name === "Keys");

        assert.ok(account);
        assert.equal(account.type, "api_key");
        assert.equal(account.active, false);

        // The owner switches to it; a guest may not.
        const switched = await call(ownerToken(), "/api/providers/expiring/active", "POST", {
            account: account.id,
        });

        assert.equal(switched.status, 200);
        assert.equal(app.accounts.activeOf("expiring").id, account.id);

        const guest = app.config.addUser("Guest", "guest");
        const denied = await call(guest.token, "/api/providers/expiring/active", "POST", {
            account: "default",
        });

        assert.equal(denied.status, 403);

        // Nobody signed in gets no list at all.
        const anonymous = await call(null, "/api/providers");

        assert.equal(anonymous.status, 401);
    } finally {
        app.detach(tab.client);
    }
});

test("a route removes a named account, and the shared file's sign-in comes back in use", async () => {
    const shown = await sheet("expiring", true);
    const account = shown.accounts.find((each: any) => each.name === "Keys");

    const response = await call(
        ownerToken(),
        `/api/providers/expiring/accounts/${account.id}`,
        "DELETE",
    );

    assert.equal(response.status, 200);
    // Keys is gone and the shared file's sign-in is in use again; the other account (Max) is untouched.
    assert.equal(app.accounts.activeOf("expiring").id, "default");
    const remaining = Object.values(accountsFile().expiring.accounts).map((each: any) => each.name);

    assert.deepEqual(remaining, ["Max"]);
});

test("accounts, and which one is in use, survive a restart", async () => {
    // A named account in use, on the provider with none.
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);

    try {
        const flowId = app.providers.startAccountLogin(owner(app), "fresh", "oauth");

        const done = await drive(tab, flowId);

        assert.equal(done.ok, true, done.error ?? "the sign-in did not finish");
    } finally {
        app.detach(tab.client);
    }

    const inUse = app.accounts.activeOf("fresh");

    assert.notEqual(inUse.id, "default");
    await app.close();

    app = await PocketApp.open({
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => {
            models.registerNativeProvider(faux.provider);
            models.registerNativeProvider(expiring as never);
            models.registerNativeProvider(fresh as never);
        },
    });

    assert.equal(app.accounts.activeOf("fresh").id, inUse.id);
    assert.equal(app.accounts.activeOf("fresh").name, inUse.name);

    const read = (await app.accountAuth.read("fresh")) as OAuthCredential;

    assert.equal(read.access, "pro-access");
});

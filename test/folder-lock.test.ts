// Folder locks: a locked folder is empty and unreadable to every session working outside it, a session working in it
// sends only to local models, and the lock file fails closed. The sandbox tests run bubblewrap for real where it is
// installed, and are skipped where it is not.
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Api, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
    FolderLocks,
    installLockGate,
    Locality,
    lockEnv,
    parseRemoteLocks,
    privateAddress,
    remotePath,
    withinRemote,
} from "../src/server/folder-lock.ts";

const context = BACKGROUND_CONTEXT;

/** A home with a locked-to-be folder `Vault` holding a secret, a project beside it, and a data folder. */
function place() {
    const home = mkdtempSync(join(tmpdir(), "hadal-lock-"));
    const vault = join(home, "Vault");
    const project = join(home, "project");
    const data = join(home, ".hadal");

    mkdirSync(join(vault, "notes"), { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(vault, "notes", "secret.md"), "the secret\n");
    writeFileSync(join(project, "readme.md"), "open\n");

    const locks = (bwrap?: string | null) =>
        new FolderLocks({ dataDir: data, home, ...(bwrap === undefined ? {} : { bwrap }) });

    return {
        home,
        vault,
        project,
        data,
        locks,
        done: () => rmSync(home, { recursive: true, force: true }),
    };
}

test("addresses on this machine, the LAN, and the tailnet are private; the rest are not", () => {
    for (const address of [
        "127.0.0.1",
        "10.1.2.3",
        "172.20.1.1",
        "192.168.1.9",
        "100.100.1.2",
        "::1",
        "fd7a:115c:a1e0::1",
        "::ffff:10.1.2.4",
    ]) {
        assert.equal(privateAddress(address), true, address);
    }

    for (const address of [
        "8.8.8.8",
        "100.128.0.1",
        "172.32.0.1",
        "2606:4700::1",
        "api.anthropic.com",
        "",
    ]) {
        assert.equal(privateAddress(address), false, address);
    }
});

test("a model is local only when every address its host resolves to is private", async () => {
    const names: Record<string, string[]> = {
        "gpu.tail0000.ts.net": ["100.70.1.2"],
        "funnel.example.ts.net": ["100.70.1.3", "34.1.2.3"],
        "api.example.com": ["34.1.2.3"],
    };
    const locality = new Locality({
        resolve: async (host) => {
            const found = names[host];

            if (found === undefined) {
                throw new Error("ENOTFOUND");
            }

            return found;
        },
    });

    assert.equal(locality.known({ baseUrl: "http://10.1.2.3:9090/v1" }), true);
    assert.equal(locality.known({ baseUrl: "http://localhost:8080/v1" }), true);
    assert.equal(locality.known({ baseUrl: "http://[::1]:8080/v1" }), true);
    assert.equal(locality.known({}), false, "no address is not local");
    assert.equal(
        locality.known({ baseUrl: "https://gpu.tail0000.ts.net:9799/v1" }),
        undefined,
        "a name is looked up first",
    );
    assert.equal(await locality.check({ baseUrl: "https://gpu.tail0000.ts.net:9799/v1" }), true);
    assert.equal(
        locality.known({ baseUrl: "https://gpu.tail0000.ts.net:9799/v1" }),
        true,
        "and kept",
    );
    assert.equal(
        await locality.check({ baseUrl: "https://funnel.example.ts.net/v1" }),
        false,
        "one public address is enough to say no",
    );
    assert.equal(await locality.check({ baseUrl: "https://api.example.com/v1" }), false);
    assert.equal(
        await locality.check({ baseUrl: "https://nowhere.invalid/v1" }),
        false,
        "a name that does not resolve is not local",
    );
});

test("a locked folder: inside it, through a symlink, and its copies elsewhere; home, root, and the data folder cannot be locked", (t) => {
    const { home, vault, project, data, locks, done } = place();

    t.after(done);

    const dsh = join(home, ".dsh", "sessions", `--${vault.slice(1).replace(/\//g, "-")}--`);

    mkdirSync(dsh, { recursive: true });
    symlinkSync(vault, join(project, "link"));

    const lock = locks();

    assert.equal(lock.any, false);
    assert.throws(() => lock.lock(home), /home/);
    assert.throws(() => lock.lock("/"), /root/);
    assert.throws(() => lock.lock(join(data, "..")), /home|data/);
    lock.lock(vault);

    assert.equal(lock.any, true);
    assert.equal(lock.inside(join(vault, "notes")), true);
    assert.equal(lock.inside(project), false);
    assert.equal(
        lock.blocked(join(project, "link", "notes", "secret.md")),
        true,
        "a symlink into it is it",
    );
    assert.equal(
        lock.blocked(join(dsh, "session.jsonl")),
        true,
        "another harness's log of it is hidden",
    );
    assert.equal(lock.inside(dsh), false, "but is not a place to work");
    assert.equal(lock.holds(home), true, "removing home would take it along");
    assert.equal(lock.blocked(join(project, "readme.md")), false);

    // Saved, and read again by the next server.
    const again = locks();

    assert.equal(again.inside(vault), true);
    assert.equal(again.unlock(vault), true);
    assert.equal(locks().inside(vault), false);
});

test("a worktree of a locked repository counts as inside it", (t) => {
    const { vault, data, locks, done } = place();

    t.after(done);

    const tree = join(data, "worktrees", "vault-feature");

    mkdirSync(join(vault, ".git", "worktrees", "vault-feature"), { recursive: true });
    mkdirSync(tree, { recursive: true });
    writeFileSync(
        join(tree, ".git"),
        `gitdir: ${join(vault, ".git", "worktrees", "vault-feature")}\n`,
    );

    const lock = locks();

    lock.lock(vault);
    assert.equal(lock.inside(tree), true);
});

test("a sealed session stays sealed, after an unlock and across a restart", (t) => {
    const { vault, locks, done } = place();

    t.after(done);

    const lock = locks();

    lock.lock(vault);
    lock.seal(7);
    lock.unlock(vault);

    const again = locks();

    assert.equal(again.isSealed(7), true);
    assert.equal(again.guarding, true, "a sealed session alone keeps the gate up");
    assert.equal(again.any, false, "but nothing is hidden");
});

test("a lock file that cannot be read fails closed", (t) => {
    const { data, locks, done } = place();

    t.after(done);
    writeFileSync(join(data, "folder-locks.json"), "{ not json");

    const lock = locks();

    assert.match(lock.broken ?? "", /not valid/);
    assert.equal(lock.guarding, true);
    assert.equal(lock.any, true);
    assert.throws(() => lock.seal(1), /restart/);
});

test("a session outside the lock cannot read, list, write, or remove inside it, by any path", async (t) => {
    const { home, vault, project, locks, done } = place();

    t.after(done);
    symlinkSync(vault, join(project, "link"));

    const lock = locks(null);

    lock.lock(vault);

    const env = lockEnv(new NodeExecutionEnv({ cwd: project }), lock, () => project);
    const read = await env.readTextFile(join(vault, "notes", "secret.md"), context);

    assert.equal(read.ok, false);
    assert.equal(!read.ok && read.error.code, "permission_denied");
    assert.equal(
        (await env.readTextFile("link/notes/secret.md", context)).ok,
        false,
        "relative, through a symlink",
    );
    assert.equal((await env.readBinaryFile(join(vault, "notes", "secret.md"), context)).ok, false);
    assert.equal((await env.listDir(vault, context)).ok, false);
    assert.deepEqual(await env.exists(join(vault, "notes", "secret.md"), context), {
        ok: true,
        value: false,
    });
    assert.equal((await env.writeFile(join(vault, "new.md"), "x", context)).ok, false);
    assert.equal(
        (await env.remove(home, { recursive: true }, context)).ok,
        false,
        "nor the folder that holds it",
    );
    assert.equal((await env.renameFile(vault, join(project, "moved"), context)).ok, false);
    assert.equal(existsSync(join(vault, "notes", "secret.md")), true);
    assert.equal(
        (await env.readTextFile(join(project, "readme.md"), context)).ok,
        true,
        "the rest is as before",
    );

    if (env.listFiles !== undefined) {
        const listed = await env.listFiles(home, { hidden: true }, context);

        assert.equal(listed.ok, true);
        assert.equal(
            listed.ok && listed.value.entries.some((entry) => entry.path.includes("secret.md")),
            false,
            "a listing from above leaves it out",
        );
    }

    // No bubblewrap here: commands cannot be kept out, so they do not run.
    const ran = await env.exec("cat Vault/notes/secret.md", { cwd: home }, context);

    assert.equal(ran.ok, false);
});

test("a session in the locked folder reads it as before", async (t) => {
    const { vault, locks, done } = place();

    t.after(done);

    const lock = locks(null);

    lock.lock(vault);

    const env = lockEnv(new NodeExecutionEnv({ cwd: vault }), lock, () => vault);
    const read = await env.readTextFile(join(vault, "notes", "secret.md"), context);

    assert.deepEqual(read, { ok: true, value: "the secret\n" });
});

const bwrap = ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path));

test(
    "in the sandbox, a locked folder is empty to a session outside it, and the lock file is read-only to one inside",
    { skip: bwrap === undefined ? "bubblewrap is not installed" : false },
    async (t) => {
        const { home, vault, project, data, locks, done } = place();

        t.after(done);
        symlinkSync(vault, join(project, "link"));

        const lock = locks(bwrap!);

        lock.lock(vault);

        const output = async (env: ReturnType<typeof lockEnv>, command: string, cwd: string) => {
            let text = "";
            const ran = await env.exec(
                command,
                { cwd, onOutput: (chunk) => (text += chunk) },
                context,
            );

            return { ok: ran.ok, code: ran.ok ? ran.value.exitCode : -1, text };
        };

        const blind = lockEnv(new NodeExecutionEnv({ cwd: project }), lock, () => project);
        const cat = await output(
            blind,
            "cat ../Vault/notes/secret.md link/notes/secret.md; ls -A ../Vault | wc -l",
            project,
        );

        assert.doesNotMatch(cat.text, /the secret/);
        assert.match(cat.text, /^0$/m, "the folder is empty");
        assert.equal(
            (await output(blind, "cat readme.md", project)).text,
            "open\n",
            "the rest is as before",
        );
        assert.equal(
            (await output(blind, "ls -A .hadal | grep -c folder-locks || true", home)).text.trim(),
            "0",
            "nor is the lock file there",
        );
        assert.equal(
            (
                await output(blind, "echo $SSH_AUTH_SOCK$DBUS_SESSION_BUS_ADDRESS", project)
            ).text.trim(),
            "",
        );
        assert.equal((await output(blind, "exit 3", project)).code, 3, "exit codes come through");

        const inside = lockEnv(new NodeExecutionEnv({ cwd: vault }), lock, () => vault);

        assert.match((await output(inside, "cat notes/secret.md", vault)).text, /the secret/);
        await output(inside, `echo '{}' > ${join(data, "folder-locks.json")} 2>/dev/null`, vault);
        assert.match(
            readFileSync(join(data, "folder-locks.json"), "utf8"),
            /Vault/,
            "a session cannot unlock its own folder",
        );
    },
);

/** A model runtime that answers every request with one text message. */
function fakeModels() {
    const sent: string[] = [];

    const answer = (model: Model<Api>, _context?: unknown, _options?: unknown) => {
        const stream = createAssistantMessageEventStream();

        sent.push(model.id);
        queueMicrotask(() => {
            const message = {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "hello" }],
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
                stopReason: "stop" as const,
                timestamp: Date.now(),
            };

            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
        });

        return stream;
    };

    return { sent, models: { streamSimple: answer, stream: answer } };
}

const model = (id: string, baseUrl: string) =>
    ({ id, provider: "test", api: "openai-completions", baseUrl }) as unknown as Model<Api>;

test("a sealed session's request to a model that is not local fails before it is sent; local ones and other sessions go on", async (t) => {
    const { vault, locks, done } = place();

    t.after(done);

    const lock = locks(null);
    const { sent, models } = fakeModels();

    installLockGate(
        models as never,
        lock,
        new Locality({ resolve: async () => ["34.1.2.3"] }),
        async (sessionId) => (sessionId === "sealed" ? { policy: { scope: "local" } } : undefined),
    );

    const cloud = model("cloud", "https://api.example.com/v1");
    const local = model("local", "http://10.1.2.3:9090/v1");

    // Nothing locked: nothing waits, nothing is asked.
    assert.equal(
        (await models.streamSimple(cloud, {} as never, { sessionId: "sealed" } as never).result())
            .stopReason,
        "stop",
    );

    lock.lock(vault);

    const refused = await models
        .streamSimple(cloud, {} as never, { sessionId: "sealed" } as never)
        .result();

    assert.equal(refused.stopReason, "error");
    assert.match(refused.errorMessage ?? "", /not in the reviewed registry/);
    assert.match(refused.errorMessage ?? "", /local models only/);
    assert.match(refused.errorMessage ?? "", /Pick a model that policy allows/);
    assert.equal(
        (await models.stream(cloud, {} as never, { sessionId: "sealed" } as never).result())
            .stopReason,
        "error",
        "the plain stream too",
    );
    assert.equal(
        (await models.streamSimple(local, {} as never, { sessionId: "sealed" } as never).result())
            .stopReason,
        "stop",
    );
    assert.equal(
        (await models.streamSimple(cloud, {} as never, { sessionId: "other" } as never).result())
            .stopReason,
        "stop",
    );
    assert.deepEqual(
        sent,
        ["cloud", "local", "cloud"],
        "the refused requests never reached the provider",
    );
});

test("with an unreadable lock file, every request to a model that is not local fails", async (t) => {
    const { data, locks, done } = place();

    t.after(done);
    writeFileSync(join(data, "folder-locks.json"), "[]");

    const { sent, models } = fakeModels();

    installLockGate(models as never, locks(null), new Locality(), async () => undefined);

    const answer = await models
        .streamSimple(
            model("cloud", "https://203.0.113.9/v1"),
            {} as never,
            { sessionId: "any" } as never,
        )
        .result();

    assert.equal(answer.stopReason, "error");
    assert.match(answer.errorMessage ?? "", /folder-locks\.json/);
    assert.deepEqual(sent, []);
});

test("a us lock allows Claude and blocks DeepSeek; an anthropic lock blocks GPT", async (t) => {
    const { vault, locks, done } = place();

    t.after(done);

    const lock = locks(null);
    const { sent, models } = fakeModels();

    installLockGate(
        models as never,
        lock,
        new Locality({ resolve: async () => ["34.1.2.3"] }),
        async (sessionId) =>
            sessionId === "sealed"
                ? { policy: { scope: "us" }, path: "/work" }
                : sessionId === "claude-only"
                  ? { policy: { scope: "anthropic" }, path: "/work" }
                  : undefined,
    );

    lock.lock(vault, [], undefined, { scope: "us" });

    const claude = model("claude-sonnet-4", "https://api.anthropic.com/v1");
    const gpt = model("gpt-5", "https://api.openai.com/v1");
    const deepseek = model("deepseek-v3", "https://api.deepseek.com/v1");

    assert.equal(
        (await models.streamSimple(claude, {} as never, { sessionId: "sealed" } as never).result())
            .stopReason,
        "stop",
    );

    const refused = await models
        .streamSimple(deepseek, {} as never, { sessionId: "sealed" } as never)
        .result();

    assert.equal(refused.stopReason, "error");
    assert.match(refused.errorMessage ?? "", /DeepSeek/);
    assert.match(refused.errorMessage ?? "", /US cloud models/);

    const blocked = await models
        .streamSimple(gpt, {} as never, { sessionId: "claude-only" } as never)
        .result();

    assert.equal(blocked.stopReason, "error");
    assert.match(blocked.errorMessage ?? "", /OpenAI/);
    assert.match(blocked.errorMessage ?? "", /Anthropic/);
    assert.deepEqual(sent, ["claude-sonnet-4"], "only the allowed model reached the provider");
});

test("the deepest lock sets the policy", (t) => {
    const { vault, locks, done } = place();

    t.after(done);

    const lock = locks(null);
    const child = join(vault, "clients");

    mkdirSync(child);

    lock.lock(vault, [], undefined, { scope: "us" });
    lock.lock(child, [], undefined, { scope: "anthropic" });

    assert.deepEqual(lock.policyFor(child), { scope: "anthropic" });
    assert.deepEqual(lock.policyFor(vault), { scope: "us" });
});

test("a seal narrows with the folder and never widens", (t) => {
    const { vault, locks, done } = place();

    t.after(done);

    const lock = locks(null);
    const child = join(vault, "clients");

    mkdirSync(child);

    lock.seal(1, { scope: "us" }, vault);
    lock.seal(1, { scope: "anthropic" }, child);
    assert.deepEqual(lock.policyForSealed(1)?.policy, { scope: "anthropic" });

    lock.seal(1, { scope: "us" }, vault);
    assert.deepEqual(
        lock.policyForSealed(1)?.policy,
        { scope: "anthropic" },
        "a wider policy changes nothing",
    );

    lock.seal(2, { scope: "us" }, vault);
    lock.seal(2, { scope: "local" }, vault);
    assert.deepEqual(lock.policyForSealed(2)?.policy, { scope: "local" });
});

test("a version 1 lock file reads as local models only, and saves as version 2", (t) => {
    const { data, locks, done } = place();

    t.after(done);
    writeFileSync(
        join(data, "folder-locks.json"),
        JSON.stringify({
            version: 1,
            locks: [{ path: "/work", hide: [], at: 1 }],
            sealed: [7],
        }),
    );

    const lock = locks(null);

    assert.deepEqual(lock.list()[0]?.policy, { scope: "local" });
    assert.deepEqual(lock.policyForSealed(7)?.policy, { scope: "local" });

    lock.setPolicy("/work", { scope: "us" });

    const saved = JSON.parse(readFileSync(join(data, "folder-locks.json"), "utf8")) as {
        version: number;
        locks: { policy: unknown }[];
        sealed: unknown[];
    };

    assert.equal(saved.version, 2);
    assert.deepEqual(saved.locks[0]?.policy, { scope: "us" });
    assert.equal(saved.sealed.length, 1);
});

test("a remote path is normalized and contained", () => {
    assert.equal(remotePath("/home//tcrypt/../tcrypt/Work/"), "/home/tcrypt/Work");
    assert.equal(remotePath("relative"), undefined);
    assert.equal(remotePath("/a/\u0000b"), undefined);
    assert.equal(withinRemote("/home/tcrypt/Work", "/home/tcrypt/Work"), true);
    assert.equal(withinRemote("/home/tcrypt/Work/soteria/a", "/home/tcrypt/Work"), true);
    assert.equal(withinRemote("/home/tcrypt/Working", "/home/tcrypt/Work"), false);
    assert.equal(withinRemote("/home/tcrypt/Work/../Other", "/home/tcrypt/Work"), false);
    assert.equal(withinRemote("/anything", "/"), true);
});

test("remote copies are checked before a lock takes them", () => {
    assert.deepEqual(parseRemoteLocks([{ host: "aphotic", path: "/home/tcrypt/Work" }]), [
        { host: "aphotic", path: "/home/tcrypt/Work" },
    ]);
    assert.deepEqual(parseRemoteLocks(undefined), []);
    assert.equal(parseRemoteLocks([{ host: "Bad Host", path: "/a" }]), undefined);
    assert.equal(parseRemoteLocks([{ host: "aphotic", path: "relative" }]), undefined);
    assert.equal(
        parseRemoteLocks(
            Array.from({ length: 9 }, (_value, index) => ({
                host: "aphotic",
                path: `/a/${String(index)}`,
            })),
        ),
        undefined,
    );
});

test("a lock keeps the remote copies of its folder", (t) => {
    const { vault, locks, done } = place();

    t.after(done);

    const remote = [{ host: "aphotic", path: "/home/tcrypt/Work" }];
    const lock = locks(null);

    lock.lock(vault, [], undefined, { scope: "us" }, remote);

    assert.deepEqual(lock.list()[0]?.remote, remote);
    assert.deepEqual(
        lock.remoteLocks("aphotic").map((entry) => entry.path),
        ["/home/tcrypt/Work"],
    );
    assert.equal(lock.lockForRemote("aphotic", "/home/tcrypt/Work/soteria/a")?.path, vault);
    assert.equal(lock.lockForRemote("aphotic", "/home/tcrypt/Working"), undefined);
    assert.equal(lock.lockForRemote("other", "/home/tcrypt/Work"), undefined);

    const again = locks(null);

    assert.deepEqual(again.list()[0]?.remote, remote, "it survives a restart");
});

// Where a session's commands ran, when, and how they went (web/host-runs.js): hosts from a `host` argument or a
// workspace address, runs paired with their results, and the summary a sheet shows.
import assert from "node:assert/strict";
import { test } from "node:test";

type Call = { type: "toolCall"; id?: string; name: string; args?: unknown };
type Block = Call | { type: "text"; text: string } | { type: "thinking"; text: string };
type Entry = {
    id?: number;
    kind: string;
    at?: number;
    blocks?: Block[];
    callId?: string;
    text?: string;
    isError?: boolean;
    command?: string;
    output?: string;
    status?: string;
    code?: number;
};
type Host = { local: boolean; name: string };
type Run = {
    key: string;
    entryId?: number;
    at: number;
    tool: string;
    subject: string;
    host: Host;
    status: string;
    durationMs?: number;
    error?: string;
};
type Summary = {
    total: number;
    local: { count: number; failed: number; lastAt: number };
    hosts: { name: string; count: number; failed: number; lastAt: number }[];
    current: Host | null;
};
type HostRuns = {
    HOST_TOOLS: readonly string[];
    workspaceHost: (cwd: unknown) => string | undefined;
    callHost: (call: unknown, options?: { cwd?: string }) => Host;
    hostRuns: (view: unknown, options?: { cwd?: string }) => Run[];
    hostSummary: (runs: unknown) => Summary;
    sessionHost: (runs: unknown) => Host | null;
    hostLabel: (host: unknown) => string;
    hostKey: (host: unknown) => string;
    hostReadout: (
        view: unknown,
        options?: { cwd?: string },
    ) => { runs: Run[]; summary: Summary; latest: Summary["hosts"][number] | null };
    shortSubject: (text: unknown, max?: number) => string;
};

// A plain ES module of the web app's: a path the type checker does not follow, as it has no types of its own.
const hostRuns = (await import(new URL("../web/host-runs.js", import.meta.url).href)) as HostRuns;

const call = (id: string, name: string, args: unknown = {}): Block => ({
    type: "toolCall",
    id,
    name,
    args,
});
const answer = (id: number, at: number, blocks: Block[]): Entry => ({
    id,
    kind: "assistant",
    at,
    blocks,
});
const result = (id: number, callId: string, at: number, text = "ok", isError = false): Entry => ({
    id,
    kind: "toolResult",
    callId,
    at,
    text,
    isError,
});
const shell = (id: number, at: number, command: string, status = "done", code?: number): Entry => ({
    id,
    kind: "shell",
    at,
    command,
    status,
    ...(code === undefined ? {} : { code }),
    output: "",
});
const view = (entries: Entry[], extra: Record<string, unknown> = {}) => ({ entries, ...extra });

const LOCAL: Host = { local: true, name: "" };
const remote = (name: string): Host => ({ local: false, name });

/** The run at `index`, which the test knows is there. */
const runAt = (runs: Run[], index: number): Run => {
    const run = runs[index];

    assert.ok(run !== undefined);

    return run;
};

function deepFreeze(value: unknown): unknown {
    if (value !== null && typeof value === "object") {
        for (const each of Object.values(value)) {
            deepFreeze(each);
        }

        Object.freeze(value);
    }

    return value;
}

test("a host argument wins, trimmed, and an unknown name is shown as given", () => {
    assert.deepEqual(hostRuns.callHost(call("a", "bash", { host: "  gpu  " })), remote("gpu"));
    assert.deepEqual(
        hostRuns.callHost(call("a", "read", { host: "nope.example" }), { cwd: "ssh://me@other/x" }),
        remote("nope.example"),
    );
    // Not a string: the folder decides.
    assert.deepEqual(
        hostRuns.callHost(call("a", "bash", { host: 7 }), { cwd: "ssh://gpu/srv" }),
        remote("gpu"),
    );
    assert.deepEqual(
        hostRuns.callHost(call("a", "bash", { host: "   " }), { cwd: "ssh://gpu/srv" }),
        remote("gpu"),
    );
    assert.deepEqual(hostRuns.HOST_TOOLS, ["bash", "read", "write", "edit"]);
});

test("a workspace address gives its host without user and port; file and Windows paths stay local", () => {
    assert.equal(hostRuns.workspaceHost("ssh://user@gpu/home/tcrypt"), "gpu");
    assert.equal(hostRuns.workspaceHost("ssh://gpu:2222/srv"), "gpu");
    assert.equal(hostRuns.workspaceHost("ssh://user@gpu:2222/srv"), "gpu");
    assert.equal(hostRuns.workspaceHost("ssh://[fe80::1]:2222/srv"), "[fe80::1]");
    assert.equal(hostRuns.workspaceHost("file:///home/tcrypt"), undefined);
    assert.equal(hostRuns.workspaceHost("C:\\work"), undefined);
    assert.equal(hostRuns.workspaceHost("/home/tcrypt"), undefined);
    assert.equal(hostRuns.workspaceHost(undefined), undefined);
    assert.deepEqual(hostRuns.callHost(call("a", "bash"), { cwd: "ssh://gpu/srv" }), remote("gpu"));
    assert.deepEqual(hostRuns.callHost(call("a", "bash"), { cwd: "file:///srv" }), LOCAL);
});

test("with no host argument and a plain folder, a call is local", () => {
    assert.deepEqual(hostRuns.callHost(call("a", "bash", { command: "ls" })), LOCAL);
    assert.deepEqual(hostRuns.callHost(call("a", "bash"), { cwd: "/home/tcrypt/projects" }), LOCAL);
    assert.equal(hostRuns.hostLabel(LOCAL), "this machine");
    assert.equal(hostRuns.hostLabel(remote("gpu")), "@gpu");
});

test("runs pair with their results, keep order, and mark running, error and done", () => {
    const entries = [
        answer(1, 100, [
            call("c1", "bash", { command: "  pnpm\n  test  " }),
            call("c2", "read", { path: "src/app.ts" }),
            call("c3", "grep", { pattern: "x" }),
            call("c4", "bash", { command: "sleep 1", host: "gpu" }),
            { type: "thinking", text: "hmm" },
        ]),
        result(2, "c1", 250, "boom\nmore", true),
        result(3, "c2", 90, "ignored"),
    ];
    const runs = hostRuns.hostRuns(view(entries));

    assert.deepEqual(
        runs.map((run) => [run.key, run.tool, run.status]),
        [
            ["c1", "bash", "error"],
            ["c2", "read", "done"],
            ["c4", "bash", "running"],
        ],
    );
    assert.equal(runAt(runs, 0).at, 100);
    assert.equal(runAt(runs, 0).entryId, 1);
    assert.equal(runAt(runs, 0).subject, "pnpm test");
    assert.equal(runAt(runs, 0).durationMs, 150);
    assert.equal(runAt(runs, 0).error, "boom");
    assert.equal(runAt(runs, 1).durationMs, 0);
    assert.equal(runAt(runs, 1).subject, "src/app.ts");
    assert.equal("durationMs" in runAt(runs, 2), false);
    assert.equal("error" in runAt(runs, 2), false);
    assert.deepEqual(runAt(runs, 2).host, remote("gpu"));
    assert.deepEqual(runAt(runs, 0).host, LOCAL);
});

test("runs come oldest first, with the entry order breaking ties", () => {
    const entries = [
        answer(1, 500, [call("b", "bash", { command: "b" })]),
        answer(2, 400, [call("a", "bash", { command: "a" })]),
    ];
    const runs = hostRuns.hostRuns(view(entries, { order: [2, 1] }));

    assert.deepEqual(
        runs.map((run) => run.key),
        ["a", "b"],
    );
    // A Map of entries is read, and sorted, the same way.
    const mapped = hostRuns.hostRuns({
        entries: new Map(entries.map((entry, index) => [index, entry])),
    });

    assert.deepEqual(
        mapped.map((run) => run.key),
        ["a", "b"],
    );
    // The same time: the view's order decides.
    const tied = hostRuns.hostRuns(
        view(
            [
                answer(3, 600, [call("c", "bash", { command: "c" })]),
                answer(4, 600, [call("d", "bash", { command: "d" })]),
            ],
            { order: [4, 3] },
        ),
    );

    assert.deepEqual(
        tied.map((run) => run.key),
        ["d", "c"],
    );
});

test("a call with no id is keyed by its entry and place", () => {
    const entries = [answer(7, 10, [call("", "write", { path: "a.txt" })])];
    const runs = hostRuns.hostRuns(view(entries));

    assert.equal(runAt(runs, 0).key, "7:0");
    assert.equal(runAt(runs, 0).tool, "write");
    assert.equal(runAt(runs, 0).status, "running");
});

test("a person's command is a local run, and a failed one is an error", () => {
    const runs = hostRuns.hostRuns(
        view(
            [
                shell(1, 50, "git push"),
                shell(2, 60, "make", "failed"),
                shell(3, 70, "false", "done", 1),
                shell(4, 80, "true", "done", 0),
            ],
            {
                conversation: { cwd: "ssh://gpu/srv" },
            },
        ),
    );

    assert.equal(runs.length, 4);
    assert.equal(runAt(runs, 0).tool, "shell");
    assert.deepEqual(runAt(runs, 0).host, LOCAL);
    assert.equal(runAt(runs, 0).status, "done");
    assert.equal(runAt(runs, 1).status, "error");
    // A command that exited nonzero failed, even though its task finished.
    assert.equal(runAt(runs, 2).status, "error");
    assert.equal(runAt(runs, 3).status, "done");
    assert.equal("durationMs" in runAt(runs, 0), false);
    assert.equal(runAt(runs, 0).entryId, 1);
});

test("a session's folder decides when a call gives no host", () => {
    const runs = hostRuns.hostRuns(
        view([answer(1, 10, [call("c1", "bash", { command: "ls" })])], {
            conversation: { cwd: "ssh://me@gpu:22/srv" },
        }),
    );

    assert.deepEqual(runAt(runs, 0).host, remote("gpu"));
});

test("the summary counts, sorts hosts and names the current one", () => {
    const runs: Run[] = [
        { key: "a", at: 10, tool: "bash", subject: "", host: LOCAL, status: "done" },
        { key: "b", at: 20, tool: "bash", subject: "", host: remote("one"), status: "error" },
        { key: "c", at: 30, tool: "bash", subject: "", host: remote("two"), status: "done" },
        { key: "d", at: 40, tool: "bash", subject: "", host: remote("one"), status: "error" },
        { key: "e", at: 15, tool: "read", subject: "", host: remote("one"), status: "done" },
    ];
    const summary = hostRuns.hostSummary(runs);

    assert.equal(summary.total, 5);
    assert.deepEqual(summary.local, { count: 1, failed: 0, lastAt: 10 });
    assert.deepEqual(summary.hosts, [
        { name: "one", count: 3, failed: 2, lastAt: 40 },
        { name: "two", count: 1, failed: 0, lastAt: 30 },
    ]);
    assert.deepEqual(summary.current, remote("one"));
    assert.deepEqual(hostRuns.hostSummary([]), {
        total: 0,
        local: { count: 0, failed: 0, lastAt: 0 },
        hosts: [],
        current: null,
    });
    // Hosts with the same last run sort by count, then by name.
    const tie = hostRuns.hostSummary([
        { key: "a", at: 5, tool: "bash", subject: "", host: remote("zeta"), status: "done" },
        { key: "b", at: 5, tool: "bash", subject: "", host: remote("alpha"), status: "done" },
    ]);

    assert.deepEqual(
        tie.hosts.map((host) => host.name),
        ["alpha", "zeta"],
    );
    assert.deepEqual(hostRuns.sessionHost(runs), remote("one"));
    assert.equal(hostRuns.sessionHost([]), null);
});

test("a subject is one line, cut with an ellipsis when too long", () => {
    assert.equal(hostRuns.shortSubject("a\n\tb   c "), "a b c");
    assert.equal(hostRuns.shortSubject("abcdef", 4), "abc…");
    assert.equal(hostRuns.shortSubject(undefined), "");
    assert.equal(hostRuns.shortSubject("x".repeat(200)).length, 120);
});

test("malformed input does not throw, and nothing given is changed", () => {
    assert.deepEqual(hostRuns.hostRuns(undefined), []);
    assert.deepEqual(hostRuns.hostRuns(null), []);
    assert.deepEqual(hostRuns.hostRuns({ entries: "no" }), []);
    assert.deepEqual(hostRuns.hostRuns({ entries: [null, 5, "x", {}, { kind: "assistant" }] }), []);
    assert.deepEqual(
        hostRuns
            .hostRuns(
                view([
                    { id: 1, kind: "assistant", at: 10, blocks: "no" } as unknown as Entry,
                    answer(2, 20, [
                        call("c1", "bash", null),
                        call("c2", "bash", { command: 42 }),
                        { type: "toolCall", name: "edit", args: {} },
                    ]),
                    { id: 3, kind: "shell", command: "x" },
                    result(4, "c1", 40),
                ]),
            )
            .map((run) => [run.key, run.subject, run.status]),
        [
            ["c1", "", "done"],
            ["c2", "42", "running"],
            ["2:2", "", "running"],
        ],
    );
    assert.deepEqual(hostRuns.hostSummary(undefined), {
        total: 0,
        local: { count: 0, failed: 0, lastAt: 0 },
        hosts: [],
        current: null,
    });

    const input = deepFreeze(
        view(
            [
                answer(1, 100, [call("c1", "bash", { command: "ls", host: "gpu" })]),
                result(2, "c1", 150, "no", true),
                shell(3, 200, "make", "timeout"),
            ],
            { conversation: { cwd: "ssh://gpu/srv" }, order: [1, 2, 3] },
        ),
    );
    const before = JSON.stringify(input);
    const runs = hostRuns.hostRuns(input);

    runAt(runs, 0).host.name = "changed";

    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(
        runs.map((run) => run.status),
        ["error", "error"],
    );
});

test("a host has a filter key, and the readout names the latest remote host in one pass", () => {
    assert.equal(hostRuns.hostKey({ local: true, name: "" }), "local");
    assert.equal(hostRuns.hostKey({ local: false, name: "gpu" }), "host:gpu");
    assert.equal(hostRuns.hostKey(null), "local");

    const readout = hostRuns.hostReadout(
        view(
            [
                answer(1, 100, [call("c1", "bash", { command: "ls" })]),
                result(2, "c1", 120),
                answer(3, 200, [call("c2", "bash", { command: "nvidia-smi", host: "gpu" })]),
                result(4, "c2", 260),
                answer(5, 300, [call("c3", "bash", { command: "df", host: "nas" })]),
                result(6, "c3", 340),
            ],
            { order: [1, 2, 3, 4, 5, 6] },
        ),
    );

    assert.equal(readout.latest?.name, "nas");
    assert.equal(readout.summary.local.count, 1);
    assert.deepEqual(
        readout.runs.map((run) => run.host.name),
        ["", "gpu", "nas"],
    );
    assert.deepEqual(
        readout.summary.hosts.map((host) => host.name),
        ["nas", "gpu"],
    );
});

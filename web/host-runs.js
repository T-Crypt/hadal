// Where a session's commands ran, when, and how they went: a session view read into runs, each with its host (this
// machine, or the SSH host an address or a `host` argument names). Pure functions with no imports, so
// `test/host-runs.test.ts` runs them in Node; the session sheet draws them.

/** The tools whose calls can run on another machine. */
export const HOST_TOOLS = Object.freeze(["bash", "read", "write", "edit"]);

const isHostTool = (name) => HOST_TOOLS.includes(name);

const text = (value) => (typeof value === "string" ? value : "");

/**
 * The host a workspace address names (`ssh://user@gpu/home/tcrypt` gives "gpu", `ssh://gpu:2222/srv` gives "gpu"),
 * without its user and port. Undefined for a local path, for `file://`, and for a scheme shorter than 2 characters, so
 * that a Windows drive (`C:\work`) stays local.
 */
export function workspaceHost(cwd) {
    if (typeof cwd !== "string") {
        return undefined;
    }

    const match = /^([a-z][a-z0-9+.-]+):\/\/([^/]*)/i.exec(cwd.trim());

    if (match === null || match[1].toLowerCase() === "file") {
        return undefined;
    }

    const authority = match[2];
    // The user, if any: everything up to the last "@" of the authority.
    const afterUser = authority.slice(authority.lastIndexOf("@") + 1);
    // A bracketed IPv6 address keeps its brackets; its port follows them.
    const host = /^\[[^\]]*\]/.test(afterUser)
        ? /^\[[^\]]*\]/.exec(afterUser)[0]
        : afterUser.split(":")[0];

    return host === "" ? undefined : host;
}

/**
 * Where a call ran: `{ local: true, name: "" }`, or `{ local: false, name }` with the name the call gives. A non-empty
 * `args.host` string wins, trimmed; anything else follows the session's folder, and a host name is never checked.
 */
export function callHost(call, { cwd } = {}) {
    const host = call?.args?.host;

    if (typeof host === "string" && host.trim() !== "") {
        return { local: false, name: host.trim() };
    }

    const fromCwd = workspaceHost(cwd);

    return fromCwd === undefined ? { local: true, name: "" } : { local: false, name: fromCwd };
}

/**
 * A subject on one line: its whitespace collapsed, trimmed, and cut to `max` characters with "…" after the cut.
 */
export function shortSubject(text, max = 120) {
    const flat = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The view's entries, in order, with each entry's place for ties in `at`. Malformed views give an empty list. */
function entriesOf(view) {
    const entries = view?.entries ?? [];
    const list = entries instanceof Map ? [...entries.values()] : entries;

    if (!Array.isArray(list)) {
        return [];
    }

    const order = Array.isArray(view?.order) ? view.order : null;
    const position = new Map();

    if (order !== null) {
        order.forEach((id, index) => position.set(id, index));
    }

    const place = (entry, index) =>
        entry?.id !== undefined && position.has(entry.id) ? position.get(entry.id) : index;

    return list
        .filter((entry) => entry !== null && typeof entry === "object")
        .map((entry, index) => ({ entry, place: place(entry, index), index }))
        .sort((a, b) => a.place - b.place || a.index - b.index)
        .map((each) => each.entry);
}

/** The session's folder: the conversation's, else the agent's. */
function cwdOf(view, given) {
    if (typeof given === "string") {
        return given;
    }

    return text(view?.conversation?.cwd) || text(view?.agent?.cwd) || undefined;
}

/** A tool result's first line, cut to 160 characters. */
function firstLine(value) {
    const line =
        text(value)
            .split("\n")
            .find((each) => each.trim() !== "") ?? "";

    return shortSubject(line.trim(), 160);
}

/**
 * Every run of a session, oldest first: each host tool call, and each of a person's commands, with its host, its
 * subject, its status, and how long it took. A call pairs with its result by call id; a call with no result is running.
 * Malformed entries are skipped, and nothing given is changed.
 */
export function hostRuns(view, { cwd } = {}) {
    const folder = cwdOf(view, cwd);
    const entries = entriesOf(view);
    const results = new Map();

    for (const entry of entries) {
        if (entry?.kind === "toolResult" && typeof entry.callId === "string") {
            const known = results.get(entry.callId);

            // A result that has a time is the one a duration counts from.
            if (
                known === undefined ||
                (typeof known.at !== "number" && typeof entry.at === "number")
            ) {
                results.set(entry.callId, entry);
            }
        }
    }

    const runs = [];

    entries.forEach((entry, place) => {
        const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : undefined;

        if (at === undefined) {
            return;
        }

        if (entry.kind === "shell") {
            runs.push({
                key:
                    typeof entry.id === "number" || typeof entry.id === "string"
                        ? String(entry.id)
                        : `shell:${place}`,
                entryId: entry.id,
                at,
                tool: "shell",
                subject: shortSubject(entry.command),
                host: { local: true, name: "" },
                status: entry.status === "done" && Number(entry.code ?? 0) === 0 ? "done" : "error",
                place,
            });

            return;
        }

        if (entry.kind !== "assistant" || !Array.isArray(entry.blocks)) {
            return;
        }

        entry.blocks.forEach((block, index) => {
            if (block?.type !== "toolCall" || !isHostTool(block.name)) {
                return;
            }

            const id = typeof block.id === "string" && block.id !== "" ? block.id : undefined;
            const args = block.args !== null && typeof block.args === "object" ? block.args : {};
            const result = id === undefined ? undefined : results.get(id);
            const status =
                result === undefined ? "running" : result.isError === true ? "error" : "done";
            const run = {
                key: id ?? `${entry.id}:${index}`,
                entryId: entry.id,
                at,
                tool: block.name,
                subject:
                    block.name === "bash" ? shortSubject(args.command) : String(args.path ?? ""),
                host: callHost(block, { cwd: folder }),
                status,
                place,
            };

            if (
                result !== undefined &&
                typeof result.at === "number" &&
                Number.isFinite(result.at)
            ) {
                run.durationMs = Math.max(0, Math.round(result.at - at));
            }

            if (status === "error") {
                run.error = firstLine(result.text);
            }

            runs.push(run);
        });
    });

    return runs.sort((a, b) => a.at - b.at || a.place - b.place).map(({ place, ...run }) => run);
}

/** The newest run's host, or null with no runs. */
export function sessionHost(runs) {
    let newest = null;

    for (const run of Array.isArray(runs) ? runs : []) {
        if (newest === null || run.at >= newest.at) {
            newest = run;
        }
    }

    return newest === null ? null : { ...newest.host };
}

/**
 * How a session's runs add up: how many, how many failed, and when the last was, here and on each host. `current` is
 * where the newest run was, or null with no runs.
 */
export function hostSummary(runs) {
    const all = (Array.isArray(runs) ? runs : []).filter(
        (run) => run !== null && typeof run === "object",
    );
    const local = { count: 0, failed: 0, lastAt: 0 };
    const hosts = new Map();
    let lastAt = 0;
    let current = null;

    for (const run of all) {
        const failed = run.status === "error";
        const at = typeof run.at === "number" && Number.isFinite(run.at) ? run.at : 0;
        const remote = run.host?.local === false;
        const name = remote ? String(run.host.name ?? "") : "";

        lastAt = Math.max(lastAt, at);

        if (current === null || at >= current.at) {
            current = { at, host: remote ? { local: false, name } : { local: true, name: "" } };
        }

        if (remote) {
            const seen = hosts.get(name) ?? { name, count: 0, failed: 0, lastAt: 0 };

            seen.count++;
            seen.failed += failed ? 1 : 0;
            seen.lastAt = Math.max(seen.lastAt, at);
            hosts.set(name, seen);
        } else {
            local.count++;
            local.failed += failed ? 1 : 0;
            local.lastAt = Math.max(local.lastAt, at);
        }
    }

    const ordered = [...hosts.values()].sort(
        (a, b) =>
            b.lastAt - a.lastAt ||
            b.count - a.count ||
            (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );

    return {
        total: all.length,
        local,
        hosts: ordered,
        current: current === null ? null : current.host,
    };
}

/** How a host is said: "@gpu" for another machine, "this machine" for this one. */
export function hostLabel(host) {
    if (host === null || host === undefined || host.local !== false) {
        return "this machine";
    }

    return `@${host.name}`;
}

/** A host's key for a filter: "local", or "host:gpu". */
export function hostKey(host) {
    return host === null || host === undefined || host.local !== false
        ? "local"
        : `host:${host.name}`;
}

/**
 * What the session's readout needs in one pass: its runs, their summary, and the remote host it names (the one used
 * most recently), or null when no call has left this machine.
 */
export function hostReadout(view, { cwd } = {}) {
    const runs = hostRuns(view, { cwd });
    const summary = hostSummary(runs);

    return { runs, summary, latest: summary.hosts[0] ?? null };
}

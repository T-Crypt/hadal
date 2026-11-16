// Where this session's commands ran: every bash, read, write and edit call, and every ! command, with its host, its
// time, and how it went. A row jumps to the call in the transcript. The data comes from web/host-runs.js.
import { useMemo, useState } from "preact/hooks";
import { jumpToEntry } from "../chat.js";
import { hostRuns, hostSummary, workspaceHost } from "../host-runs.js";
import { closeSheet, openSheet, store } from "../store.js";
import { formatWhen, html, Icon, Sheet, timeAgo, useMinute } from "../ui.js";

/** How many rows the sheet draws at first, and each time older runs are asked for. */
const PAGE = 80;

/** A run's time: milliseconds under a second, then one decimal of a second or minute. */
function duration(ms) {
    if (ms === undefined) {
        return "";
    }

    if (ms < 1000) {
        return `${ms} ms`;
    }

    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)} s`;
    }

    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The mark a run's status shows, with its word for the title. */
const MARKS = {
    done: ["✓", "ran"],
    error: ["×", "failed"],
    running: ["…", "running"],
    stopped: ["–", "no result"],
};

/** One run: its state, host, tool, subject, duration and time, and what failed. */
function RunRow({ run }) {
    // A call with no result is running only while HADAL is: after a restart, or a denial, it has none to come.
    const live = store.state.view.live?.busy === true;
    const stale = run.status === "running" && (!live || Date.now() - run.at > 10 * 60_000);
    const state = stale ? "stopped" : run.status;
    const [mark, word] = MARKS[state] ?? MARKS.done;
    const where = run.host.local ? "this machine" : `@${run.host.name}`;

    return html`<button
        class=${`host-run ${state}`}
        data-part="host-run"
        data-host=${run.host.local ? "local" : run.host.name}
        aria-label=${`${word}: ${run.tool} on ${where}${run.subject === "" ? "" : `, ${run.subject}`}. Open in the transcript.`}
        title=${`${run.tool} on ${where}: open it in the transcript`}
        onClick=${() => jumpToEntry(run.entryId)}
    >
        <span class="host-run-line">
            <span class=${`host-run-mark ${state}`} title=${word} aria-hidden="true">
                ${mark}
            </span>
            <span class="host-run-host">${run.host.local ? "here" : `@${run.host.name}`}</span>
            <span class="host-run-tool">${run.tool}</span>
            <span class="host-run-subject">${run.subject || "—"}</span>
            <span class="host-run-duration">${duration(run.durationMs)}</span>
            <span class="host-run-time" title=${formatWhen(run.at)}>${timeAgo(run.at)}</span>
        </span>
        ${run.error && html`<span class="host-run-error">${run.error}</span>`}
    </button>`;
}

/** The session's runs: a filter by machine, then the runs newest first, each opening its call. */
export function HostRunsSheet() {
    // The rows say how long ago they ran: draw again as the minute turns.
    useMinute();
    const { view, server } = store.state;
    const sheet = store.state.sheet;
    const cwd = view.agent?.cwd ?? view.conversation?.cwd;
    const { runs, summary } = useMemo(() => {
        const all = hostRuns(view, { cwd });

        return { runs: all, summary: hostSummary(all) };
    }, [view.entries, view.order, cwd]);
    const asked = typeof sheet?.host === "string" && sheet.host !== "" ? sheet.host : "all";
    const [filter, setFilter] = useState(asked);
    const [limit, setLimit] = useState(PAGE);
    const known =
        filter === "all" ||
        filter === "local" ||
        summary.hosts.some((host) => host.name === filter);
    // A host turned off since the sheet opened, or a stale name: show all rather than nothing.
    const active = known ? filter : "all";
    const shown =
        active === "all"
            ? runs
            : runs.filter((run) =>
                  active === "local" ? run.host.local : run.host.name === active,
              );
    const newest = [...shown].reverse();
    const visible = newest.slice(0, limit);
    const here = server?.hostname ?? "this machine";
    const workspace = workspaceHost(cwd);
    const failed = runs.filter((run) => run.status === "error").length;
    const latestRemote = summary.hosts[0];

    const pick = (next) => {
        setFilter(next);
        setLimit(PAGE);
    };

    return html`<${Sheet} title="Where commands ran" onClose=${closeSheet}>
        <p class="muted small" data-part="host-runs-lead">
            ${
                runs.length === 0
                    ? "No commands have run in this session yet."
                    : `${runs.length === 1 ? "One command" : `${runs.length} commands`}${failed > 0 ? ` · ${failed} failed` : ""} · newest first. ${workspace === undefined ? `HADAL works here (${here}) unless a call names a host.` : `This session works on ${workspace}.`}`
            }
        </p>
        ${
            runs.length > 0 &&
            html`<div class="host-run-filters" data-part="host-run-filters" role="group" aria-label="Filter by machine">
                <button
                    class=${`host-filter ${active === "all" ? "on" : ""}`}
                    aria-pressed=${active === "all"}
                    onClick=${() => pick("all")}
                >
                    All <span class="num">${summary.total}</span>
                </button>
                <button
                    class=${`host-filter ${active === "local" ? "on" : ""}`}
                    aria-pressed=${active === "local"}
                    title=${here}
                    onClick=${() => pick("local")}
                >
                    <${Icon} name="terminal" size=${11} /> here
                    <span class="num">${summary.local.count}</span>
                    ${summary.local.failed > 0 && html`<span class="failed" title=${`${summary.local.failed} failed`}>!${summary.local.failed}</span>`}
                </button>
                ${summary.hosts.map(
                    (host) => html`<button
                        class=${`host-filter ${active === host.name ? "on" : ""} ${latestRemote?.name === host.name ? "latest" : ""}`}
                        aria-pressed=${active === host.name}
                        title=${latestRemote?.name === host.name ? "The host this session reached most recently" : `Runs on ${host.name}`}
                        onClick=${() => pick(host.name)}
                    >
                        <${Icon} name="server" size=${11} /> @${host.name}
                        <span class="num">${host.count}</span>
                        ${host.failed > 0 && html`<span class="failed" title=${`${host.failed} failed`}>!${host.failed}</span>`}
                    </button>`,
                )}
            </div>`
        }
        ${
            runs.length === 0
                ? html`<p class="muted" data-part="host-runs-empty">
                      HADAL's bash, read, write and edit calls show here, and so do the commands you run with !.
                  </p>`
                : html`<div class="host-run-list" data-part="host-run-list">
                      ${visible.map((run) => html`<${RunRow} key=${run.key} run=${run} />`)}
                  </div>`
        }
        ${
            newest.length > visible.length &&
            html`<button
                class="button wide ghost"
                data-part="host-runs-more"
                onClick=${() => setLimit(limit + PAGE)}
            >
                Show ${Math.min(PAGE, newest.length - visible.length)}
                ${Math.min(PAGE, newest.length - visible.length) === 1 ? "older run" : "older runs"}
            </button>`
        }
        ${
            runs.length > 0 &&
            html`<p class="muted small host-runs-note" data-part="host-runs-note">
                A call on another machine runs only through a host the owner allowed.
                ${
                    store.state.me?.role === "owner" &&
                    html` <button class="link" onClick=${() => openSheet({ type: "hosts" })}>
                        Hosts settings
                    </button>`
                }
            </p>`
        }
    <//>`;
}

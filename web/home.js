// The Atlas: the wide home screen, shown beside the session list when no session is open. HADAL organizes
// environments, not chats, so the place you arrive lists them: each folder at work as one plate, with its light, what
// is alive in it, and its latest sessions; beside them, what needs you across all of them, and where to jump back in.

import { folderColor } from "./avatar.js";
import { useEffect, useRef } from "preact/hooks";
import { envLight, sessionMark } from "./sessions.js";
import {
    actions,
    attempt,
    canSteer,
    folderLockOf,
    navigate,
    openSheet,
    scoped,
    store,
    workspaceOrder,
} from "./store.js";
import { html, Icon, Keys, shortPath, timeAgo } from "./ui.js";

/** How many environments the Atlas shows, and how many of each one's sessions. */
const MAX_ENVIRONMENTS = 12;
const SESSIONS_PER_ENVIRONMENT = 3;

/** The live sessions by folder, the most recently active folder first. */
export function environments(sessions) {
    const byFolder = new Map();

    for (const session of sessions) {
        if (session.archived || typeof session.cwd !== "string") {
            continue;
        }

        const list = byFolder.get(session.cwd) ?? [];

        list.push(session);
        byFolder.set(session.cwd, list);
    }

    return [...byFolder]
        .map(([cwd, list]) => {
            const ordered = [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

            return {
                cwd,
                sessions: ordered,
                light: envLight(ordered),
                working: ordered.filter((session) => session.busy).length,
                waiting: ordered.filter((session) => session.waiting).length,
                updatedAt: ordered[0]?.updatedAt ?? 0,
            };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The folder's last part, and the rest of its path. */
function folderName(cwd, home) {
    const short = shortPath(cwd, home) || cwd;
    const cut = short.replace(/\/+$/, "").lastIndexOf("/");

    return cut < 0
        ? { head: "", name: short }
        : { head: short.slice(0, cut + 1), name: short.slice(cut + 1) };
}

function SessionLine({ session, index, part }) {
    return html`<button
        class="atlas-session"
        data-part=${part}
        onClick=${() => navigate(session.id)}
    >
        ${
            index !== undefined &&
            html`<span class="atlas-key" data-part="home-recent-key">${index + 1}</span>`
        }
        <span
            class=${`state-mark ${sessionMark(session).shape}`}
            data-part="session-mark"
            style=${`--folder:${folderColor(session.cwd)}`}
            aria-hidden="true"
        ></span>
        <span class="atlas-session-title">${session.title ?? "New session"}</span>
        <span class="atlas-session-meta">
            ${
                session.waiting
                    ? html`<span class="session-needs">${canSteer() ? "needs you" : "waiting"}</span>`
                    : session.busy
                      ? html`<span class="atlas-working">working</span>`
                      : timeAgo(session.updatedAt)
            }
        </span>
    </button>`;
}

function Environment({ env, home, canStart }) {
    const { head, name } = folderName(env.cwd, home);
    const lock = folderLockOf(env.cwd);
    const startHere = () =>
        attempt(async () => {
            const created = await actions.createSession(env.cwd);

            navigate(created.id);
        });

    return html`<section class="atlas-env" data-part="home-env" data-light=${env.light}>
        <header class="atlas-env-head" data-part="home-env-head">
            <span class=${`env-led ${env.light}`} aria-hidden="true"></span>
            <span class="atlas-env-name" title=${env.cwd}>
                <span class="atlas-env-path">${head}</span><b>${name}</b>
            </span>
            ${
                lock &&
                html`<span class="env-seal" title=${`Locked to local models: ${lock.path}`}
                    ><${Icon} name="lock" size=${11} /><span>local</span></span
                >`
            }
            ${
                canStart &&
                html`<button
                    class="atlas-env-new"
                    data-part="home-env-new"
                    title=${`New session in ${env.cwd}`}
                    aria-label=${`New session in ${env.cwd}`}
                    onClick=${startHere}
                >
                    <${Icon} name="plus" size=${14} />
                </button>`
            }
        </header>
        <dl class="atlas-readout" data-part="home-env-readout">
            <div><dt>sessions</dt><dd>${env.sessions.length}</dd></div>
            <div class=${env.working > 0 ? "on" : ""}><dt>working</dt><dd>${env.working}</dd></div>
            <div class=${env.waiting > 0 ? "warn" : ""}><dt>waiting</dt><dd>${env.waiting}</dd></div>
            <div><dt>last</dt><dd>${timeAgo(env.updatedAt)}</dd></div>
        </dl>
        <div class="atlas-env-sessions">
            ${env.sessions
                .slice(0, SESSIONS_PER_ENVIRONMENT)
                .map(
                    (session) =>
                        html`<${SessionLine} key=${session.id} session=${session} part="home-env-session" />`,
                )}
        </div>
    </section>`;
}

export function Splash() {
    const { sessions, server } = store.state;
    const home = server?.home;
    const recent = workspaceOrder().slice(0, 5);
    const envs = environments(sessions);
    const needs = sessions.filter(
        (session) => !session.archived && (session.waiting || session.failed),
    );
    const splash = useRef(null);
    const canStart = canSteer() && !scoped();

    // The keys beside Jump back in: a digit opens its session, as Alt and the digit does anywhere. Only where they
    // show: on a narrow screen the home screen is hidden, and a digit there must do nothing.
    useEffect(() => {
        const onKey = (event) => {
            const target = event.target;
            const index = Number(event.key) - 1;

            if (
                event.defaultPrevented ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                !(index >= 0 && index < 5) ||
                target?.closest?.("input, textarea, select, [contenteditable]") ||
                store.state.sheet ||
                store.state.launcher ||
                !(
                    splash.current?.checkVisibility?.() ??
                    splash.current?.getClientRects().length > 0
                )
            ) {
                return;
            }

            const session = workspaceOrder()[index];

            if (session) {
                event.preventDefault();
                navigate(session.id);
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    return html`<div class="splash atlas" data-part="home" ref=${splash}>
        <header class="atlas-head">
            <h1 class="atlas-title">
                Environments <span class="atlas-count">${envs.length}</span>
            </h1>
            <div class="atlas-actions" data-part="home-actions">
                ${
                    canStart &&
                    html`<button
                        class="button primary"
                        onClick=${() => openSheet({ type: "cwd", mode: "new" })}
                    >
                        <${Icon} name="plus" size=${14} /> New session <${Keys} keys="Alt N" />
                    </button>`
                }
                <button class="button" onClick=${() => store.set({ launcher: true })}>
                    <${Icon} name="command" size=${14} /> Launcher <${Keys} keys="Mod K" />
                </button>
                <button
                    class="icon-button"
                    data-part="home-menu"
                    aria-label="Menu"
                    title="Menu"
                    aria-haspopup="dialog"
                    aria-expanded=${store.state.sheet?.type === "menu"}
                    onClick=${() => openSheet({ type: "menu" })}
                >
                    <${Icon} name="more" />
                </button>
            </div>
        </header>
        <div class="atlas-body">
            <div class="atlas-envs" data-part="home-envs">
                ${
                    envs.length === 0
                        ? html`<p class="atlas-empty">
                              No environments yet. Start a session in a folder and it shows here, with what
                              is alive in it.
                          </p>`
                        : envs.slice(0, MAX_ENVIRONMENTS).map(
                              (env) =>
                                  html`<${Environment}
                                          key=${env.cwd}
                                          env=${env}
                                          home=${home}
                                          canStart=${canStart}
                                      />`,
                          )
                }
            </div>
            <aside class="atlas-side">
                <section class="atlas-needs" data-part="home-needs">
                    <h2 class="atlas-heading" data-part="home-heading">
                        Needs you <span class="atlas-count">${needs.length}</span>
                    </h2>
                    ${
                        needs.length === 0
                            ? html`<p class="atlas-quiet">Nothing waits for you.</p>`
                            : needs
                                  .slice(0, 8)
                                  .map(
                                      (session) =>
                                          html`<${SessionLine} key=${session.id} session=${session} part="home-env-session" />`,
                                  )
                    }
                </section>
                ${
                    recent.length > 0 &&
                    html`<section class="atlas-recent" data-part="home-recent">
                        <h2 class="atlas-heading" data-part="home-heading">Jump back in</h2>
                        ${recent.map(
                            (session, index) =>
                                html`<${SessionLine} key=${session.id} session=${session} index=${index} part="home-recent-row" />`,
                        )}
                    </section>`
                }
            </aside>
        </div>
    </div>`;
}

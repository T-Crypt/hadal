# Build plan: `hadal cli` (terminal tab client)

Status: plan only. No code edited. Companion to `docs/design/cli.md` and its Recommendations (2026-11-17).

## Goal and done-criteria

`hadal cli` opens one session in the terminal and speaks the tab protocol, over loopback or an attached server, with no second harness. Done when:

- `hadal cli` signs in over loopback, lists sessions, joins one, submits typed text, and prints the run as it arrives: tool calls as one line, a failure's reason, tokens/s, TTFT, context %.
- `hadal run -p "<prompt>"` (headless one-shot) exits after the run ends.
- `npm run check`, `npm run lint`, `npm test` pass.
- RSS of a CLI process stays within the server's own steady state plus a small fixed margin (no second harness).

## Context (files and functions)

- `bin/hadal.js`: Node version check, loads `src/launcher/main.ts`.
- `src/launcher/main.ts`: `startServer`, `restartServer`, child process; holds `launcher.lock`.
- `src/launcher/options.ts`: `parseArgs`, `Options`, `fail`, `HELP`.
- `src/launcher/term.ts`: terminal helpers (`choose`, `confirm`, colors, `NO_COLOR`).
- `src/server/http/api.ts`: `/api` routes; `createApi`; sessions, events, poll, submit via `conversation-routes.ts`.
- `src/server/commands.ts`: `Commands.createSession`, `submit`, `configure`; `SessionMeta` write in `init`.
- `src/server/docs.ts`: `SessionMeta` type and `SessionsDoc`.
- `web/store.js`: `PROTOCOL = 6`, tab protocol, `hello`.
- `test/helpers.ts`: `fakeTab` shape, `owner`, `newSession`, `say`.

## Data shape

1. `SessionMeta.client?: "terminal"` in `src/server/docs.ts`, stored, default absent so older servers ignore it. Set at creation when `POST /api/sessions` carries `client: "terminal"`; `createSession` accepts an optional `client` and writes it in the session's `init`.
2. CLI config `~/.hadal/cli.json` (mode 0600): `{ serverUrl, profile?, leaveServer? }`. No secrets. Token is a browser-session grant stored separately in `~/.hadal/cli-session.json` (mode 0600), rotated on server restart.
3. Attached child: `{ process, ready, leave }` in the CLI process only; no file state.
4. Locks: CLI touches neither `launcher.lock` nor `harness.lock`. Attached launch spawns the launcher child and waits for readiness; detached use talks to an existing server.

## APIs (verified)

- Auth: `Authorization: Bearer <token>` works in `auth.ts` (`userByToken`); owner token and browser-session grant both resolve.
- Routes used (all already served):
    - `GET /api/me`, `GET /api/sessions`, `POST /api/sessions` (`{ cwd, title, worktree, client }`)
    - `GET /api/events` / `GET /api/poll` (tab protocol), `POST /api/switch`, `POST /api/c/:id/submit`
    - `GET /api/c/:id` view, `POST /api/c/:id/configure`, approvals route, fork route in `conversation-routes.ts`
- No new routes in phase 1. Phase 2 adds `client` only as a field, not a route.

## Pending design choices (recommended defaults)

1. Invocations: `hadal cli` interactive; `hadal run -p` headless one-shot. Default `hadal cli`.
2. Server reach: loopback first; attached launch if no server on the port; `--leave` keeps it. Default attached.
3. CLI theming: one palette from HADAL tokens (`#E5F1FC` on `#050D19`, signal `#65D9FF`, etc.); no per-person themes. Default one palette.
4. Context budget features (overhead, pruning, last-read cache) stay server-side; CLI shows the meter only.
5. Rate-limit wait stays server-side; CLI shows `limited` state and offers retry/stop.
6. Approval modes: start with always-ask; cached/write/yolo later. Default always-ask.
7. `NO_COLOR` and reduced motion respected. Default on.

## Lightweight guardrails

- New module `src/cli/` only; no import of `PocketApp`, `app.ts`, or `harness.lock`.
- Reuse the launcher child for attached mode; never open a second harness.
- Hold neither lock; ask the launcher to start a server.
- Measure RSS before and after; report the number.
- No new routes in phase 1; reuse `http/api.ts` and `commands.ts`.
- No Files tile, Browser panel, diff review, subagents board, peek tiles, or theming in v1.
- Concurrency: `hadal serve` and `hadal cli` may run at once; sessions sync to the web UI; CLI holds neither lock.

## Phases (verifiable units)

### Phase 0: bootstrap and contract (no server code)

1. Add `src/cli/` skeleton (`main.ts`, `client.ts`, `render.ts`, `config.ts`) with `--help`. Check: `node --check src/cli/*.ts`.
2. Write `docs/design/cli-contract.md`: actions and routes in parity style. Check: file exists and every route named exists in `api.ts`.

### Phase 1: smallest first step

3. Implement sign-in: owner token or bearer grant; store grant; loopback reach. Check: `hadal cli` prints signed-in user.
4. List sessions via `GET /api/sessions`; join one via events/poll. Check: session list prints.
5. Submit typed text; print run deltas, tool one-liners, failure reason. Check: manual run against faux server.
6. Add `client: "terminal"` field to `SessionMeta` and `createSession` param; CLI passes it. Check: new session shows `client: "terminal"`.

### Phase 2: attached launch and polish

7. Attached launch: spawn launcher child if no server; shut down on exit unless `--leave`. Check: `hadal cli` on a machine with no server starts and stops one.
8. Headless `hadal run -p`. Check: exits 0 after run.
9. `client: "terminal"` chip in session list (web, reuse `sessionChips`/`sessionWords`). Check: UI test.
10. Approvals over the same route; "open in browser" link. Check: approval prompt works in terminal.

### Phase 3: deferred

Fork, model roles (`--smol` etc.), approval modes, export HTML, profile isolation, crash restore. Each as its own ticket.

## Do not

- Do not import `PocketApp` or open `harness.lock` in `src/cli/`.
- Do not add a second harness instance.
- Do not rename or change scope/history/fork settings of document kinds.
- Do not add new routes in phase 1.

## Risks and undo

- Two clients, one protocol: keep affordances behind `commands.ts`.
- Attached child stranded on crash: use launcher child and signal handling; never hold locks.
- Revert: remove `src/cli/` and the `client` field (additive, default absent).

## Review focus

The CLI is a tab, not a harness: it signs in, hellos, submits, and reads; all state and locks stay server-side.

## Open decisions

- Whether `hadal cli` should accept a server URL for remote (default loopback only; remote via bearer grant is phase 3).
- Whether the `client` field should also cover browser-created sessions started from a terminal context (default no).

SELF-CHECK: pass

## Status (2026-11-17)

Phases 0, 1, and most of 2 are built; see "Built (2026-11-17)" in `cli.md`. Done: the skeleton, the contract list, sign-in,
session list and join, submit with the transcript drawn as it arrives, `client: "terminal"` plus the browser chip,
attached launch with `--leave`, `run` with an exit code, reconnecting stream, approvals by `y`/`n`, `/stop`, `/open`,
and `--session` to pick up a browser session.

Not built: a full-screen TUI, attachments, diffs, Files/Browser panels, model roles, approval modes, export, profile
isolation, crash restore of a specific run, and any RSS measurement. The lightweight guardrails hold: `src/cli/` imports
no `PocketApp`, the CLI holds neither lock, and no route was added.

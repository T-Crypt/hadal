# Two commands: `hadal serve` and `hadal cli`

Ideas, not a build order. Nothing here copies another harness; the named projects are cited only as the source of an
idea. Every claim about this code was read in this branch on 2026-11-15.

## Where HADAL stands today

`bin/hadal.js` checks Node and starts `src/launcher/main.ts`. That launcher is already a small terminal program: it
reads options (`options.ts`), asks how devices reach the server (`access.ts`: this device, LAN, a Cloudflare quick
tunnel, Tailscale, Tailscale Serve), runs the server as a child, restarts it on exit 75 or a crash, keeps the tunnel up,
and draws a menu, a panel, and a QR code in the terminal (`term.ts`). So `hadal` today is only ever a server, and the
terminal is its control panel, not a client.

The interesting part is what a client costs here. A browser tab is a thin thing:

- it sends work with `POST /api/c/:id/submit` and reads the answer from `/api/events` (an event stream) or `/api/poll`
  (long polling, `src/server/http/events.ts`);
- it says what it understands in its `hello` (`PROTOCOL` in `web/store.js`, now 6), and gets a full view once, then
  deltas: the message being written goes as its new characters only, and a tab may name what it kept (`have=`) so an
  unchanged session sends nothing back;
- every mutation carries the `X-Pocket` header, and the server checks the person, the session, the turn, and the spend
  before it does anything (`http/api.ts`, `commands.ts`).

Nothing in that contract is browser-only. `test/helpers.ts` already drives a whole app instance with `fakeTab`, a tab
that is plain Node. That is the strongest argument for a terminal client: the client is a known shape, and a fake of it
already exists and passes.

## The split to aim at

```
hadal serve   the launcher as it is today, plus a `serve` subcommand name
hadal cli     a terminal tab: it opens one session and speaks the tab protocol
```

`hadal cli` should not embed the harness. It should be a tab: sign in with the owner token or a bearer token, `hello`
with its own protocol number, and then submit and read. Two ways to reach the server follow from that, and both are
honest:

1. **Loopback.** `hadal cli` talks to a running `hadal serve` on `127.0.0.1`. Sessions a person starts in the terminal
   are ordinary sessions in the same database, so they appear in the web UI with no new plumbing.
2. **Attached launch.** `hadal cli` with no server on the port starts one (the same child the launcher starts), stays
   attached to it, and shuts it down on exit unless told to leave it.

Option 2 is what makes the CLI usable on a machine with no server running. It also decides the shape of the code: the
CLI must not import `PocketApp`, or a CLI run and a server run would each open the harness and fight over
`harness.lock`.

**How a CLI session should look in the web UI.** Do not invent a second kind of session. Add one field to the session
entry (`client: "terminal"`, stored, defaulted absent so older servers ignore it), and let the session list show it as
a chip with a word, the way extensions' chips already work (`sessions.js` reads `sessionChips`, `sessionWords`). A
fork of a terminal session is a normal session. The reason to store it rather than infer it: a person should be able to
pick up a terminal session in the browser, and where it began stays a fact about its history, not about who is looking.

## What the CLI is for, and what it is not

Worth having, because it is genuinely better in a terminal:

- starting and following work over SSH, where a browser is awkward and a phone is worse;
- one keystroke to hand a task to a session in the folder you are standing in, with the same spend limits, approvals,
  and memory the web UI has, since those are server-side;
- reading a run as text, diffing, and answering an approval prompt without leaving the shell.

Not worth having in the first pass, because they are the parts that would cost the most and buy the least:

- the Files tile, the Browser panel, the diff review screen, the subagents board, and peek tiles. These are the web UI.
  The CLI should reach them by pointing the person at the browser (`/s/<id>`), not by redrawing them in cells.
- per-person theming. `web/themes.js` and the palette engine are CSS variables; a terminal has 256 colours and no
  cascade. Use one palette derived from the same `--o-*` values, and stop there.

`docs/parity.md` holds 247 rows that must keep working at five widths. That list is the web UI's contract. The CLI's
contract should be written the same way, and much shorter, before the first screen is built: the actions it can take,
each with its route.

## The visuals worth taking from other harnesses, as ideas

The live scrolling transcript, the collapsible tool call, the one-line status with tokens a second, and the staged
"thinking" line are all worth matching in look. They are cheap here because the state already exists server-side: the
room's `live` view carries the message being written as deltas, `pocket.run-failure` says why a run ended, and the
status line's figures (tokens a second, time to first token, context percent) are already computed for
`web/composer.js`. The terminal has to draw them, not measure them.

Role-based model routing (OMP), stages as commit units with cheap gates beside the loop (ORCA), parent-owned subagents
with detach, committee, and handoff patterns and idempotent creation (Paseo), map-first reads and edits by symbol name
with same-turn verification (Empryo), narrow plugin seams and a fail-closed sandbox (DSH), and the append-only log with
one remote transport (Pi Durable, Pi Pocket) are already HADAL's direction. They belong to the harness and the prompt,
not to the terminal, and the CLI inherits them for free. Where they are not in yet, they should be designed once, in
`docs/`, and used by both clients.

## Costs and risks to name before anyone builds it

- **Two clients, one protocol.** Every new interactive feature now has two places to be right, and `docs/parity.md`
  grows a second column. Mitigate by putting new affordances behind the existing command layer (`commands.ts`) rather
  than in the browser, and by writing the CLI's contract list first.
- **Text is a worse medium for some things.** Approvals, diffs, and "which of these five models" are clearer on a
  screen. The CLI needs a clean "open this in the browser" path for exactly those, and it already has shareable
  addresses.
- **The lock and the child.** An attached CLI that starts a server must not strand it on a crash, and must not start a
  second one. `launcher.lock` and `harness.lock` exist; the CLI should hold neither and ask the launcher to start one.
- **A second terminal UI to maintain.** `src/launcher/term.ts` is small and does one job. A full transcript view is a
  different order of code. Budget for it honestly, or the CLI quietly becomes a second front end nobody keeps current.

## The smallest first step that proves the design

One command, no new server code: `hadal cli` signs in over loopback, lists sessions, joins one, submits what you type,
and prints the run as it arrives, including a tool call's one line and a failure's reason. If that does not feel good in
an afternoon, the rest of the plan is wrong and it is cheap to know now. If it feels good, add: pick the folder, answer
an approval, a fork, and the `client: "terminal"` chip. Nothing on that list needs a new route that `http/api.ts` and
`commands.ts` do not already serve, which is the thing to verify first.

---

## Recommendations (2026-11-17)

Items to address or implement, drawn from the DeepSeek DSH harness, the local vision docs (`homelab/projects/active/hadal/PLAN.md`), and OMP CLI visual improvements, for a `hadal cli` tuned to HADAL's face. Full version: artifact `hadal-cli-recommendations`.

### From DSH

- Headless one-shot: `hadal cli -p "<prompt>"` (or `hadal run`), model from settings, not flags.
- Profile/preset layering: ship `lab` and `lab-full` presets that disable dangerous loops; presets re-read on every call.
- Declare per-model context windows in settings; do not inherit a default.
- Compaction per model (0.8 x real ctx, retain ~0.16), applied via overlay, not preset edits.
- Reasoning effort wiring per model: `off / low / medium / high`.
- Bound retry policy for the JIT backend (< 5 eager retries).
- Explicit compat flags on the route: developer role, `max_tokens`, usage in stream.
- Tailnet-only publishing: CLI never binds 0.0.0.0.
- Token handling: login token rotates on restart; stable credential is the `browser-session` grant.
- Sandbox: shell runs under bwrap; document the prerequisite.
- Document the whole-row patch replace gotcha.

### From the local vision docs

- Registry, zones, epochs: CLI status shows mounted loadout and sounding.
- Objective with done-when: CLI prints the check result; `Esc Esc` stops.
- Lanes and brief on demand via `/brief`; do not print every turn.
- Live pruning shown as `[pruned: ..., recall <id>]` plus a `recall` command.
- Ledger: CLI writes rows like the web UI.
- Architecture profiles in the model picker, with conformance score.
- Measure first (S1): the CLI must not raise steady-state RSS or open a second harness instance.

### From OMP CLI

- Model roles: `--smol`, `--slow`, `--plan`, `--goal`, mapped to HADAL router stages; keep `!fast` / `!deep` / `!role`.
- Advisor runtime (`--advisor`) mapped to the review stage.
- Approval modes: `--approval-mode` (always-ask, cached, write, yolo).
- Session export to HTML (`--export`).
- Profile isolation (`--profile`).
- Modes (`--mode`: text, json, rpc, rpc-ui).
- Extension flags (`--hook`, `-e/--extension`, `--no-extensions`, `--no-skills`, `--skills`).
- LSP and PTY toggles (`--no-lsp`, `--no-pty`).
- Crash restore (`--restore`) including subagents.
- Limits (`--max-time`, `--auto-approve`).
- Defer import from Claude/Codex.

### Visual tuning to HADAL's face

- One palette from HADAL tokens: `#E5F1FC` on `#050D19`, signal `#65D9FF`, second voice `#9B8AFF`, ok `#72E6C1`, warn `#F0C674`, err `#FF8A9B`, muted `#526B82` (non-text only).
- Mark as progress spinner; status line with tokens/s, TTFT, context % in tabular mono; live line with elapsed time.
- Tool calls as one-line trace nodes (hollow running, filled ok, cross on failure).
- Approval plate in warn color, command shown whole, keys shown.
- Atlas-like session list on start.
- Respect `NO_COLOR` and reduced motion.

### Contract and safety

- Write the CLI contract first (actions and routes), in the style of `docs/parity.md` but shorter.
- Answer approvals over the same route; offer "open in browser" for diffs.
- The CLI must not import `PocketApp` or open `harness.lock`.
- Hold neither `launcher.lock` nor `harness.lock`; ask the launcher to start a server.

### Defer

Files tile, Browser panel, diff review screen, subagents board, peek tiles, per-person theming, import from Claude/Codex.

### Smallest first step

`hadal cli` signs in over loopback, lists sessions, joins one, submits what you type, and prints the run as it arrives, including a tool call's one line and a failure's reason. Verify `http/api.ts` and `commands.ts` already serve every action on that list before building screens.

## Concurrency (2026-11-17)

`hadal serve` and `hadal cli` are independent processes that may run at the same time.

- `hadal serve` runs the server and its web UI; `hadal cli` is a tab that talks to it over loopback.
- `hadal cli` with no server on the port may start one (attached launch) and shut it down on exit, unless `--leave`.
- Sessions started from the CLI are ordinary sessions in the same database, so they appear in the web UI with no new plumbing. The `client: "terminal"` field records where a session began; it does not restrict who can open it.
- Neither process holds an exclusive lock that blocks the other: the CLI holds neither `launcher.lock` nor `harness.lock`. Attached launch spawns the launcher child and waits for readiness.
- If both are live, they share one server; the CLI never starts a second harness.

## Built (2026-11-17)

The first pass is in `src/cli/`: `main.ts` (the tab), `client.ts` (sign-in, files, the protocol's calls), `events.ts`
(the stream and its reconnects), `view.ts` (what a view draws), `render.ts` (palette, status line), `server.ts` (find
or start a server). `bin/hadal.js` sends `cli` and `run` there, and strips `serve` for the launcher.

What it does:

- `hadal cli` signs in over loopback, joins the last session it used (or asks, with a numbered list), and types in it.
- `hadal run -p "text"` sends one message, waits for the run to finish, and exits 0, or 1 after a failed answer.
- `hadal cli --session 12` picks up a session the browser started; `--list` prints the sessions and exits.
- With no server on the port it starts the launcher (the same process `hadal serve` runs), waits until it answers, and
  stops it on the way out unless `--leave` was given. The CLI holds neither lock.
- The event stream reconnects on its own (1 s, then doubling to 30 s), and every reattach brings the session's full
  view, so a server restart under the tab loses nothing. The run itself is durable on the server: Ctrl+C detaches and
  prints `hadal cli --session <id>`.
- The transcript draws as it arrives: the answer as it is written, each tool call on one line with its result, a failed
  run in red, and an approval prompt that takes `y` or `n`. `/stop` aborts the run, `/open` prints the browser address.
- A session the CLI made carries `client: "terminal"`, and the browser's session list shows it as a `terminal` chip.
  The same session is at `/s/<id>`, and either client can go on with it: the state is the server's, not the tab's.
- `NO_COLOR`, `TERM=dumb`, and no TTY fall back to plain text; the status line is drawn only on a terminal.

Not built yet: a full-screen TUI (the CLI prints lines, it does not paint a screen), attachments, diffs, and the
Files/Browser panels. `--leave`, attached launch, `--session`, and the chip are done.

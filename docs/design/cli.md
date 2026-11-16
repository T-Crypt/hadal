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

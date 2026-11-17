# CLI implementation notes (2026-11-17, second pass)

Self-review notes for another agent, covering the review of the first pass and the improvements made.

## Review of the first pass

What the first pass got right: it proved a tab can be a client (`/api/sessions`, `/api/events`, `/api/c/:id/submit` need
nothing browser-only), and it added `client: "terminal"` additively. What it got wrong:

1. **No reconnects.** One dropped stream ended the CLI, so a server restart closed the terminal's view of a run that
   was still going. That contradicted the durability claim.
2. **No attached launch.** The design says `hadal cli` starts a server when none is on the port; the first pass only
   talked to one that was already running.
3. **Rendering was raw JSON** (`[view] {"full":true,…}`), so the terminal was unusable for reading a run.
4. **No approvals, no stop, no exit code.** A refused send printed a bare status number.
5. **`hadal serve` broke.** `bin/hadal.js` sent everything but `cli`/`run` to the launcher without stripping the
   `serve` word, and the launcher's parser rejected it.
6. **A run could hang `hadal run`.** Completion was never detected; the process waited for the stream to end.
7. **Smaller defects:** the model was picked by guessing instead of using the server's default; `attach` used
   `HADAL_DIR` directly instead of `resolveDataDir`; the SSE parser joined `data:` lines without a separator.

## What was changed

| File                                                   | Change                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/hadal.js`                                         | Strips `serve` before the launcher parses; `cli`/`run` go to `src/cli/main.ts`.                                                                                                                                                                                                                                |
| `src/cli/server.ts` (new)                              | Finds a server by `/api/pocket/info`, starts the launcher when none answers, waits up to 90 s, stops it on exit with SIGTERM then SIGKILL.                                                                                                                                                                     |
| `src/cli/events.ts` (new)                              | SSE reader (multi-line `data:`, comments skipped) and `followStream`, which reconnects 1 s, 2, 4 … 30 s; a 401/403 is fatal, not retried.                                                                                                                                                                      |
| `src/cli/view.ts` (new)                                | `Printer`: entries drawn once by id watermark, the answer streamed as it is written, tool calls on one line, results marked ok/fail, failed runs in red, approvals offered once, `answered`/`busy`/`failed` for `run`'s exit.                                                                                  |
| `src/cli/render.ts`                                    | Palette from HADAL's tokens, `NO_COLOR` and non-TTY fallback, a status line that is rewritten only on a terminal.                                                                                                                                                                                              |
| `src/cli/client.ts`                                    | `Flags` type, `--session`, `--new`, `--list`, `--no-start`, `--leave`, `--thinking`, `--verbose`; `apiJson` that carries the server's message; `lastSession` in `cli.json`; `HELP`.                                                                                                                            |
| `src/cli/main.ts`                                      | Attached launch, sign-in, list/choose/create, `ensureModel` from `server.defaultModel` then `llama-swap/agent`, header with `/s/<id>`, input loop with `y`/`n`, `/stop`, `/open`, `/help`, `/exit`, `send` with one retry on the same request id, `run` exit code, signals detach without killing the session. |
| `src/server/docs.ts`                                   | `SessionMeta.client?: "terminal"` (already from the first pass).                                                                                                                                                                                                                                               |
| `src/server/commands.ts`                               | `createSession` accepts `client` and stores it when it is `terminal`.                                                                                                                                                                                                                                          |
| `src/server/http/api.ts`                               | `POST /api/sessions` passes `client` through only when it is `terminal`.                                                                                                                                                                                                                                       |
| `web/sessions.js`                                      | A `terminal` chip on sessions that began in the terminal (spreads the cached chips array first).                                                                                                                                                                                                               |
| `web/composer.js`                                      | The model chip says `none` instead of clipping `no mo…` on a phone.                                                                                                                                                                                                                                            |
| `test/cli.test.ts` (new)                               | 12 tests: frames, flags, text helpers, drawing a view once, a failed answer, approvals, and the `client` field through `app.sessions`.                                                                                                                                                                         |
| `docs/design/cli.md`, `cli-plan.md`, `phone-review.md` | Status, plan status, and the phone review.                                                                                                                                                                                                                                                                     |

## The connection between `serve` and `cli`

- One database, one session list. The CLI creates sessions with the same route the browser uses, marked `client:
"terminal"`, which is additive: an older server ignores it and an older row lacks it.
- The browser shows the chip, and the same session at `/s/<id>`; the CLI prints that address in its header and on
  `/open`.
- Either side may go on with the session. The CLI streams the same view a browser gets, and it joins a session that the
  browser is writing in (`--session N`) without taking it over: both are tabs, and the server fans events to both.
- The run is on the server. Ctrl+C in the CLI detaches (`hadal cli --session N` comes back); it never kills a run the
  terminal did not start.
- With no server, the CLI starts the launcher, which holds `launcher.lock`; the CLI holds neither lock, so a second
  terminal or a browser joins the same server rather than starting another.
- `hadal serve` and `hadal cli` therefore work alone or together, as asked.

## Checks run

- `npm run check` (tsc, the types file, docs-site reference): pass, after each step.
- `npm run lint` and `npx prettier`: pass.
- `node --test test/cli.test.ts`: 12 pass.
- `node --test test/sessions.test.ts`: 14 pass; `extension-sessions` + `linked-sessions`: 31 pass.
- Manual, against a throwaway server on `:8799` (`--data /tmp/hadal-cli-test2`):
    - `hadal run -p "say hello again"` printed the header, the user line, a tool call and its result, the answer, then
      `done`, exit 0.
    - `hadal cli --list` printed the sessions with `terminal`/`browser` and busy/idle.
    - `hadal cli --session 21` under a PTY (`script -qec`) drew the session's history and then sent a message.
    - Attached launch with no server: started one, listed, and stopped it on exit; `--leave` left it running.
    - `hadal serve --help` and `hadal cli --help` both print the right help.
- Phone UI: two headless Chromium runs at 390x844 and 320x700 (screenshots read), plus an element-box measurement; no
  overflow, fields 16px, hit layers present. See `phone-review.md`.

## Not verified

- The web `terminal` chip was confirmed in a headless Chromium shot at 390x844 (`/tmp/phone-atlas2.png`): the session
  row carries the chip under its title.
- No RSS measurement of a CLI process. The structural guard is that `src/cli/` imports no harness module; a figure is
  still owed.
- No test drives `followStream` against a real restart.
- `run` mode with a run longer than the stream's 30 s stall window was not exercised end to end.

## Open items for the next agent

1. A full-screen TUI is deliberately absent. Before building one, decide whether the printed transcript is enough.
2. Approvals that carry fields (`form: true`) say to answer in the browser, with a placeholder `<session>` in the URL
   that should be the real id.
3. `oneLine` cuts at 120 chars for a status row; long tool names may still overflow narrow terminals.
4. The status line is rewritten on every live view (about 90 ms). It compares text first, so idle runs cost nothing, but
   a long run redraws often; consider a 250 ms floor.
5. `settleRun` trusts `printer.busy` plus `answered`; a run that fails before any assistant entry leaves busy false and
   answered false, and `run` would wait until the stream's next event. Add a failure signal from `sessions` or a timeout.

## Release review (2026-11-17, third pass)

What a release review found and what changed, for the next reader.

- **A failed run with no answer left `hadal run` waiting forever.** `settleRun` now ends on a failure too, and waits out
  a retry or a limit wait first, so it exits on the run's end and not on the first attempt's failure.
- **A send that never reached the server left `run` attached to an idle session.** It now exits 1 with a line that says
  so.
- **The status line's seconds stood still.** Views arrive when something changes, so a long think showed `working 0s`.
  `Printer.tick()` redraws once a second, and the line is cut to the terminal's width so a narrow window does not wrap
  it into artifacts.
- **A server started with `--leave` died when the terminal closed.** The launcher is now spawned detached, with its
  output in `<data>/cli-server.log` instead of a pipe that would break (EPIPE) once the CLI is gone.
- **`serverAnswers` took any 200 as HADAL.** It now reads `/api/pocket/info` and requires `{"name":"hadal"}`, so another
  program on the port is not mistaken for a server.
- **A first `hadal cli` on a fresh machine said "No token".** The token is read after the attached server has started,
  which is when it writes one.
- **`--data` was not a CLI flag**, so a test or a second data folder was impossible and an unknown flag was silently
  ignored. `--data DIR` sets `HADAL_DIR` for the whole command, and an unknown option exits 2 with a line that says so.
- `hadal --help` now lists `cli`, `run` and `serve`.
- Docs: `docs/cli.md` (user guide), a `docs/features.md` entry, `docs/index.md` and the docs site sidebar.
- CI: a "Check the command line" step loads both programs and prints help before the suite runs.

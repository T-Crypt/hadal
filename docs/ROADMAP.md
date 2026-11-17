# HADAL roadmap

High level plan, 2026-11-17. This page says where HADAL goes and why. Each item names the metric that decides whether it
stays; a feature that does not move its metric is removed. Per-change plans live beside it in `docs/design/`.

## Where HADAL is now

A durable, multiplayer server that runs agent sessions on local or cloud models, a browser client, and a terminal
client (`hadal cli`) that speaks the same protocol. The prompt is byte-stable within a session, context is pruned before
it is summarised, and several context features were measured against another harness (see the README's measured
section). It does not yet have more than one engine behind one server, usage history a person can read, or the profile page that
would make the rail's last button worth its slot.

## Principles

1. **The server owns the state.** Sessions, runs, usage and approvals live in the database. Clients are tabs; closing
   one loses nothing. Every feature must work from both clients, or name why it cannot.
2. **Measure on the same task.** A change to the prompt, the tools or the loop is compared before and after on the same
   task, model and engine, reading `/api/metrics/activity`. Numbers in a paper are a lead, not a result.
3. **Closer to the model means fewer surprises.** A stable prefix, a stable tool list, and pruning before summarising
   beat a clever prompt rebuilt every turn.
4. **Any number of engines.** One GPU, many GPUs, or a rack of machines on the network is a configuration, not a
   variant of the product. Nothing in the code assumes one card.
5. **Reversible by default.** Every schema addition is optional and defaulted; every feature has an off switch; every
   data change has a documented undo.
6. **No AI attribution.** Commits, PRs and docs carry the author's name only.

## Track 1: reliability (server and CLI)

Goal: a run survives anything short of the database being lost.

| Item                | What changes                                                                                                                       | Metric                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Stream resilience   | Reconnect with backoff on both clients; a reattached tab gets a full view; an interrupted send is retried with the same request id | Runs lost per week: 0                              |
| Run ledger          | Every run's start, end, outcome and failure reason is a row a client can read after the fact                                       | Runs with an unknown outcome: 0                    |
| CLI parity          | `hadal cli` covers approvals with fields, attachments, `/stop`, model and thinking switches, and `hadal run --json` for scripts    | Actions a person must do in a browser, per task: 0 |
| Crash recovery test | A test kills the server mid-run and asserts the run resumes and the CLI shows the same transcript                                  | Test green in CI                                   |
| Backpressure        | A slow tab is cut off and resyncs instead of holding the server's memory; already bounded for streams, needs a CLI case            | RSS under a stalled client: flat                   |
| Memory budget       | Measure the server with 1, 10 and 100 open sessions; set `MemoryHigh` from the measured figure                                     | RSS per open session: recorded                     |

## Track 2: closer to the model

Goal: the best local-model harness, measured against the same task. Local models spend tokens on the work, not on
the harness.

- **Prefix discipline.** The system prompt stays byte-stable for a session. The date, the objective and the budget go
  last. A test asserts every request starts with the one before it.
- **Prune, then summarise.** Extend live pruning: a read of a file since edited, a repeated call's earlier output, an
  error whose fix is known, old soundings. Each becomes a stub with a recall handle. Regret is measured: recalls per
  hundred prunes.
- **Profiles per architecture.** A table maps the served model's architecture (`general.architecture`, expert count,
  context) to a profile: thinking budget per role, tool-repair strictness, loop-guard repeats, read chunk size,
  compaction thresholds, fork policy. A new architecture is one row.
- **Tool-call conformance.** About 40 scripted calls through the engine's own template: single, parallel, nested
  arguments, long strings, unicode, a call after thinking, a call after an error. A model gets a role above a
  threshold. Runs in `model-smoke` before an alias is published.
- **Constrained tool calls (experimental).** Constrain decoding of the call to the tool's JSON schema where the engine
  supports grammars. Metric: malformed calls and repairs per 100 calls. Kill if decode slows by more than the repairs
  save.
- **Speculative read-only prefetch (experimental).** While the model generates, run the reads the ledger predicts
  (after a search, the top files; after an edit, the diagnostics). Read-only tools only. Metric: hit rate, wall time
  per turn.

## Track 3: many workstations

Goal: one server, several engines, each request to the engine that can serve it best.

- **Endpoint registry.** An endpoint is a name, a base URL, a key reference, a model list, a concurrency limit and a
  locality (loopback, LAN, tailnet, cloud). Today's providers are the start; this adds health, load and cache state.
- **Routing.** A request goes to the endpoint that holds the model and has room, preferring the one whose cache the
  session already warmed. A run keeps its endpoint between tool calls unless it must move, and a move is visible.
- **Queueing.** Per-model queues with a position a client can show, and a fair share across people. The current
  per-model turn-taking generalises to several endpoints.
- **Failure handling.** An endpoint that fails health checks leaves rotation, and its queued work moves. A run that
  cannot be served fails with a reason a person can act on.
- **Removing the one-GPU wording.** No doc, page or comment claims a single card. The README, `docs/features.md` and
  the settings copy say what the code does: any number of OpenAI-compatible endpoints.

## Track 4: the code dashboard and the profile

Goal: a person can see what they spent, what they shipped, and how the models they use behave, in one place.

The rail's last button is a name today. It becomes the person's profile, in HADAL's look.

- **Usage ledger.** Tokens in, out, cached and written; cost; requests; failures; time to first token; tokens a
  second. Recorded per request per session per model per person, already partly in `spend.ts` and `usage`. Kept
  rollups per hour and per day so a year is cheap to read.
- **A contribution calendar in HADAL's style.** One square per day for the last 53 weeks, sized by the metric chosen:
  commits, tokens, runs, or spend. Hover and tap give the day's figures; the week, month and year totals sit above it.
  Not GitHub's colours: depth steps from the Bell palette, with the signal colour for the best day.
- **Commits.** Counts from the session's folder and worktrees, attributed by author, per day. A commit that a HADAL
  session made is marked as such.
- **Model and engine figures.** Per model: requests, tokens, cache hit rate, average time to first token, tokens a
  second, failures. Per engine: load and queue time. This is the page a person checks before choosing a model.
- **Profile settings, Discord-like in structure only.** Name, avatar, colour, signature, session defaults (model,
  thinking level, folder), notification choices, and what the profile page shows to other people. Owner settings stay
  in Appearance and People, not here.
- **Privacy.** A person's profile shows their own usage to them; what others see is a per-person choice, default
  "name and avatar only". Spend is owner-visible unless the person shares it.

Data shape: a new document kind for daily rollups, keyed by person and day, written by the request path; a view computed
at read time for a range. No stored total-only aggregates, so a change to what is counted can be recomputed.

## Track 5: interface

- **Profile page** at the rail's last button, on desktop and phone.
- **Shell on Bell tokens**: the navigator, the readout rail, the composer as a console tray, and panels that dock on a
  wide screen. `docs/parity.md` is the checklist.
- **Phone**: the navigator as a drawer under 700px, the profile page reachable from the places sheet, and the command
  surface kept one row tall.
- **CLI**: a `--json` mode for scripts, and a compact status line that reads well at 80 columns.

## Research intake

Leads from Hugging Face's paper index (read 2026-11-17, all unverified here). Each is a candidate experiment under
Track 2, with the metric named before the work starts.

| Paper                                                                                                                 | Date       | What it suggests                                                          | Experiment                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [SWE-Pruner: Self-Adaptive Context Pruning for Coding Agents](https://huggingface.co/papers/2601.16746)               | 2026-01-23 | The agent decides what to prune from its own task state, not a fixed rule | Compare a model-chosen prune set against the rule-based pruner on the same task: tokens per task, regret |
| [SWE-Pruner Pro](https://huggingface.co/papers/2607.18213)                                                            | 2026-07-20 | The model already knows what to drop; ask it, cheaply                     | A single tool call asking for prune candidates, timed against the rule set                               |
| [LMCache](https://huggingface.co/papers/2510.09665)                                                                   | 2025-10-08 | A KV cache layer shared across sessions and engines                       | Measure prefix reuse across sessions on one engine before building anything                              |
| [LatentRemedy](https://huggingface.co/papers/2610.18014)                                                              | 2026-10-13 | Non-prefix KV reuse for multi-agent work                                  | Only if subagents share long context: hit rate, wall time                                                |
| [DLite: History-free Speculative Decoding for Agentic AI](https://huggingface.co/papers/2610.23787)                   | 2026-10-16 | Draft models that do not need the full history                            | Engine-side, not harness-side: note it for the engine choice                                             |
| [Small Language Models for Efficient Agentic Tool Calling](https://huggingface.co/papers/2512.15943)                  | 2025-12-17 | Targeted fine-tuning can beat larger models at tool calls                 | Informs the conformance suite and role thresholds, not code                                              |
| [Hearsay: Can an Auditor Trust the Record a Deployed Agent Harness Writes?](https://huggingface.co/papers/2609.32495) | 2026-09-26 | The run record needs to be auditable                                      | Shapes the run ledger's fields and immutability                                                          |
| [Dynamic Harness Search](https://huggingface.co/papers/2610.04137)                                                    | 2026-10-02 | Choose the harness shape per query                                        | Too far from the one-loop design: keep as a note                                                         |

A lead earns code only after a task-set comparison on this machine. A paper's own numbers are never quoted as ours.

## Milestones

Each ends in a check that a reviewer can run.

1. **Run ledger and CLI parity.** Runs recorded with outcomes; CLI answers approvals with fields; `run --json`.
   Check: kill the server mid-run, resume, both clients show the same transcript.
2. **Usage rollups.** Per-request usage written per person per model, daily rollups, an endpoint that answers a range.
   Check: a week of test traffic equals the sum of its requests.
3. **Profile page.** Usage, commits, calendar and settings behind the rail button, phone included.
   Check: parity row for the profile, measured contrast, and a person's own view against a second person's.
4. **Endpoint registry.** Two engines behind one server, routing by model and cache, health and queue state visible.
   Check: a run on engine A, a tool call, and a second run on engine B, with the swap shown.
5. **Prune experiments.** One paper-backed experiment per task set, with the metric reported before the code lands.

## Non-goals

- A second harness inside the CLI. The CLI is a client.
- Per-person theming in the terminal.
- A hosted service or an account system beyond the local one.
- Copying another product's dashboard. The figures are HADAL's own, in HADAL's look.

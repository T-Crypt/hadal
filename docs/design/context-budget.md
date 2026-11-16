# Keeping a small context model working: the budget, the pruning, and what Lantern can see

Ideas, with the files each one touches. Most models HADAL is pointed at have a 262,144 token window, and some have
less, so the budget is the design constraint, not a corner case. Read `notes/RESEARCH.md` for the measurements behind
this and `docs/architecture.md` for how state moves.

## What already exists

- `compaction.ts` writes the summary that replaces old entries, per model, within a quarter of the model's window and
  32,768 tokens, at the model's own threshold. `test/compaction*.test.ts` covers the threshold, the reserve, and a run
  whose compaction fails.
- `context-meter.ts` keeps the figure the status line shows as a percent of the window.
- `pruner.ts` trims what a tool returns before it becomes part of the record.
- `pip-compact.ts` compacts Lantern's own conversation.
- The prompt cache keeper (`cache-keeper.ts`) replays a warm request at 90 percent of the cache lifetime, so a long
  session that is thinking does not pay to re-read its own prefix.

The gap is not compaction. The gap is that everything above reacts to a window that is already nearly full, and the
static part of the request, which nobody is answering, is a large share of it on a 262k model.

## 1. Measure the fixed overhead, and let only Lantern see it

The static part of a request is knowable and mostly the same every turn: the system prompt, the tool catalog, the skill
list, the memory rules, the project's instructions. On a small window that is the difference between room to work and
no room to work, and today no single place adds it up.

Add `overhead.ts` (name to be settled) that renders the prompt the way a request would and reports the tokens of each
part: system prompt, tools, skills, memory, and the rest, for one session and for the app. It writes a weekly snapshot
into the data folder, so the owner can see the trend rather than a single reading.

Show it in Lantern only, at first. The reason is in `docs/architecture.md`: Lantern is one conversation with its own
tool selection and its own person, and everything about it is already private to that person. A sheet in the web UI
would want per-session figures, which is a second question. Lantern can answer "what is costing me context this week"
and "which skills did you actually use this month" from these snapshots, and the owner can then turn off the modules
that cost and never get used.

The skill-use part is honest only if it is measured: count which skills `skills.ts` actually put in the prompt, not
which ones are installed. An unused skill costs nothing; one whose description sits in every request costs its
description, every turn, forever.

## 2. Prune by age and by kind, before the window forces a summary

`pruner.ts` trims tool output at the moment it arrives. The next step is a rule about old content, not new content: the
body of a file read forty turns ago is worth less than the last two turns, and a long `bash` result is nearly worthless
after a later result superseded it.

The shape worth trying is a replace-not-drop pass that runs where compaction runs, and that never touches: the newest
turn, anything a person quoted or pinned, anything an approval or a memory lesson points at, and the summary. A
replaced body becomes one line naming what was there and how to read it again, so "read that file again" stays cheap and
correct.

Two rules make this safe rather than clever:

- **Same-turn proof.** The pass that rewrites history reports what it replaced, in its own turn, the way `docs`
  activity lines do today. If a person cannot see what left, they cannot trust what stays.
- **Nothing durable is rewritten in place.** Pi Durable's entries are an append-only record; a compaction adds a head
  marker and a room reads the active context from there. Pruning must go the same way: a new projection of the context,
  never a mutation of stored entries. `docs/architecture.md` is firm that browsers only see committed state, and the
  history has to stay readable for a fork.

The A/B that decides it: the same task, same model, same llama-swap server, twice, with the pass on and off, reading
prompt tokens, cache hits, output, and wall time from `/api/metrics/activity`, as `notes/RESEARCH.md` prescribes. Ship it
only if it keeps or improves cache hits. Pruning that costs the cache is a loss on every model with a cached prefix.

## 3. RAM, not the context window, is where the working set should live

The ask: keep the model's window for reasoning, and hold everything else in the process, ready to re-render into the
next request when it is asked for.

Most of that already happens: `PocketApp` keeps conversations in memory, read back from `hadal.sqlite` at start, and a
room projects a window of the newest 50 to 100 entries rather than the whole history. Three concrete additions:

- **A last-read cache per session.** The text of files a session read, keyed by path and mtime, so a re-read after a
  prune is a cache hit rather than a disk read, and so the pruner can say "this is still available" honestly. Bounded,
  and dropped on a restart: it is a cache, not truth, exactly like `provider-limits.json` being only a hint.
- **Retrieved content stays out of the record.** A tool result that is a slice of a large file should carry its handle
  (path, range, hash) plus the slice, and the projection should be able to shrink the slice without losing the handle.
- **One number people can trust.** The status line already shows context as a percent. Show what is in the window and
  what is one call away, in the same place, so "I am running out" and "I am holding it in RAM" look different.

## 4. Map first: read the shape before the bytes

The rule already written in `AGENTS.md` ("read the map first", "know what an edit touches before you make it") wants a
budgeted artifact in the prompt, not a habit. `docs/map.md` is the human version; the model needs a machine version that
fits a fixed share of the window.

Shape: an index of files, exported symbols, and imports, built at session start and refreshed on the file-watch path
`watchTree` already uses, sized to a slice of the window (a fixed token figure the owner can set, small by default). It
answers three questions without a read: where is X defined, what imports this file, and what breaks if this changes.
A model that can answer those from the prompt stops spending its window on discovery.

What it must not become: a second source of truth that goes stale. The rules that keep it honest are the ones the cache
keeper already follows: derive it from the files, rebuild it when the watcher fires, mark it as a hint if the build
failed, and never let a stale entry beat a fresh read. `notes/RESEARCH.md` lists two external takes on this
(`ast-outline`, `cocoindex-code`); both are vendor claims, so the decision stays an A/B on our own stack.

## What to do first, and how to tell

Order by what is measurable and reversible: overhead figures first (it is a report, and it can be wrong harmlessly),
then the last-read cache (a cache miss costs nothing but time), then the prune pass behind its own setting, then the
index. Each one gets the same test: a battery of tasks on a 262k model, on and off, comparing prompt tokens, cache hits,
output, wall time, and whether the answer got worse.

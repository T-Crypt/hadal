# Release notes

How to write the notes of a HADAL release. They go in the release pull request's description and, unchanged, in the GitHub release.

The notes are for people who run HADAL, and some of them read on a phone. Each release answers these questions in this order:

1. Must I do anything before or after I update?
2. What is new or better for me?
3. What changed for my theme or extension?
4. Who made it, and how was it checked?

## The rules

- **Lead with what people get, not with how it works.** "Runs wait out rate limits instead of failing", not "A limit gate wraps `streamSimple`".
- **One idea per bullet, one sentence after a bold name.** Keep the sentence under about 30 words. If people need more, add at most 3 sub-bullets, or link the docs.
- **No internal names outside "For theme and extension authors".** File names, functions, classes, and settings keys belong there or in the docs.
- **Credit at the end of the bullet**, in parentheses: `(#139, by @vitalNohj)`. For an issue that a person reported: `(#131, reported by @vitalNohj)`. Use "Fixes #N" where the release pull request should close the issue.
- **Leave out empty sections.** A small release can be a few bullets and the update steps.
- **Put anything one-way or risky in a `[!WARNING]` alert** at the top. Put needed steps (`npm install`, a restart) in a `[!IMPORTANT]` alert.
- **The app reads the warning.** Menu → Update HADAL asks the owner to confirm a release whose notes have a `[!WARNING]` or `[!CAUTION]` alert, never installs it by itself, and does not go back from it by itself. So put every step that a person must do by hand, or that cannot be undone, in that alert. Updates run `npm ci` (a git checkout) or `npm install -g` (a global npm install) and restart by themselves. A release must be on the npm registry's `latest` tag for an npm install to take it (a beta is on `beta`, for people who turn on beta updates), and the notes come from the GitHub release of the same version. [releases.md](releases.md) tells when releases and betas come out.
- **Keep the review story short and folded** in a `<details>` block. Always say what was not tested.

## The style

The notes read like a person telling another person what changed, in the order they would ask. What makes them work:

- **The opener names the release in one line.** No "we are excited". "A terminal client, named provider accounts, and a
  roadmap." A person knows in five words whether this release is for them.
- **The update line comes before the features.** `[!IMPORTANT]` with one line, and the honest answer that no step is
  needed by hand when that is true. The details stay under Updating.
- **Highlights are the same items as below, said shorter.** Each one names the outcome, not the part: "Ctrl+C detaches,
  a restart reconnects, and nothing that happened meanwhile is lost", not "the event stream reconnects with backoff".
- **A section per kind of change, not per module.** New, Improved, Fixed. A person reads the section that matches what
  they noticed, and skips the rest.
- **Fixed items start with the symptom.** "`hadal run` waited forever when a run failed before writing an answer." The
  new behavior goes in the next sentence. A person who met the bug recognizes it in three words.
- **Numbers go in the bullet when there are numbers.** Exit codes, counts of tests, a percentage. They make a claim
  checkable and they are what people quote back.
- **An additive field says what to do when it is absent.** In "For theme and extension authors", name the field, say
  older rows leave it out, and say the safe default. That is the whole instruction an author needs.
- **Updating is numbered, and it ends with what happens to open clients.** "Every open terminal client reconnects by
  itself after the restart" is the line a person on a phone wants before they tap update.
- **The check block is folded, short, and it says what was not tested.** Five bullets at most: the commands, the suite
  with its real numbers, the manual paths, then `**Not tested:**`. A note that hides its gaps reads as marketing; one
  that names them reads as true.
- **No internal names, no AI attribution, no em dashes.** The release page is part of the product.

Length target: 40 to 80 lines of Markdown for a release with several changes. A small release is shorter. If a section
would hold one weak bullet, leave the section out.

## The template

```markdown
<One or two sentences: what this release is about.>

> [!IMPORTANT]
> **To update:** <the steps, in one line>. Details under [Updating](#updating).

> [!WARNING]
> <Only for a one-way or risky step: what happens, and what to do first.>

### Highlights

- **<Name>.** <What it does for you.> (<credit>)

### New

- **<Name>.** <One sentence.> (<credit>)

### Improved

### Fixed

### Security

### For theme and extension authors

- **<API or surface name>.** <What changed, and what to do.> (experimental)

### Updating

1. <Step.>
2. <Step.>

<details>
<summary>How this release was checked</summary>

- <At most 5 bullets: reviews, tests, live use.>
- **Not tested:** <what was not checked.>

</details>

**Thanks** to <names, with what each one did>.

**Full changes:** https://github.com/T-Crypt/hadal/compare/vX.Y.Z...vA.B.C
```

### Sections

| Section                         | What goes in it                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Highlights                      | The 2 to 5 changes most people notice. They can repeat items from the sections below, in fewer words.                   |
| New                             | Features that did not exist.                                                                                            |
| Improved                        | Faster, clearer, or easier things that people already had. Give a number when there is one ("about 40% less work").     |
| Fixed                           | Bugs that people met. Say what went wrong, not what the code did.                                                       |
| Security                        | Fixes that protect people's data, sign-ins, or machine, and dependency updates for advisories.                          |
| For theme and extension authors | API changes, new extension points, renamed classes or parts, and what an author must change. Mark experimental members. |
| Updating                        | Numbered steps. Say when a restart or `npm install` is needed, and what is one-way.                                     |

### The title

`HADAL A.B.C: <2 to 4 headline changes, in plain words>`, under about 80 characters.

## A worked example

The notes of v0.29.0, which this page's style comes from:

```markdown
A terminal client, named provider accounts, and a roadmap.

> [!IMPORTANT]
> **To update:** Menu → Update HADAL in the app, or `npm install` in a git checkout, then restart if the update did
> not. Nothing in the stored data needs a step by hand.

### Highlights

- **A terminal client.** `hadal cli` joins a session from this machine's terminal, draws the run as it arrives, and
  answers approvals with a `y` or `n`. `hadal run -p "text"` sends one message and exits 0, or 1 after a failed run.
- **One session, both clients.** A session the terminal made shows a `terminal` chip in the browser's list, and opens
  at `/s/<id>`. The run lives on the server: Ctrl+C detaches, a restart reconnects, and nothing that happened
  meanwhile is lost.

### Fixed

- **`hadal run` waited forever** when a run failed before writing an answer. It now exits 1 at the run's end, after
  any retry or limit wait.
- **A server started with `--leave` died when its terminal closed.** It now runs detached, logs to `cli-server.log`
  in the data folder, and outlives the terminal.

### For theme and extension authors

- **`client` on a session.** A row of `GET /api/sessions` can carry `client: "terminal"` when the terminal made it;
  earlier rows and browser sessions leave it out, so treat a missing value as a browser session.

### Updating

1. In the app: Menu → Update HADAL.
2. In a git checkout: `npm install`, then restart HADAL.
3. Every open terminal client reconnects by itself after the restart, and shows the whole session again.

<details>
<summary>How this release was checked</summary>

- `npm run check`, `npm run lint`, `npm run format:check`, and the docs site build with every link checked.
- The full test suite on this machine: 1993 tests, 1982 passed. The 2 failures were browser-guest timeouts under
  load; the file passed 3 of 3 when run alone, and CI skips browser tests.
- The terminal client by hand: a first run on a fresh data folder, attached launch with and without `--leave`,
  `--list`, `--session`, the failure exit code, and a stream reconnect across a server restart.
- **Not tested:** approvals that need typed fields in the terminal (it says to answer in the browser); a memory
  figure for a CLI process.

</details>
```

What to copy from it: the flat opener, the update line before anything else, symptoms in Fixed, the additive-field
instruction, numbered steps that end with what open clients do, and a check block that names its two gaps. The full
page, with its screenshots of nothing and its whole list of sections, is at
<https://github.com/T-Crypt/hadal/releases/tag/v0.29.0>.

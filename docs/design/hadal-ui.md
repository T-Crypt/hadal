# HADAL's look: depth and signal

Status: landed on `feat/hadal-look` (2026-11-14). The shell (rail, sessions list, transcript, composer, sheets,
panels) is unchanged in structure and function; everything here is how it looks. The plan this executes is homelab
`projects/active/hadal/PLAN.md` sections 3 to 7, with one scope call: the U2 shell rebuild (dock, navigator, stage,
inspector) is deferred. Tokens, parts, and states are laid so it can build on this without redoing it.

2026-11-15: the default became **Bell** (below): steel plates replace the blue water, corners drop to the etched
set, and the old blue stays selectable as the `zone` palette. Structure still unchanged. That same day Bell's five
structure layers landed in order: the environments-first navigator, the readout rail, the console-tray composer, the
porthole panels, and the aligned call log. Message rows and images then moved to the same log language (below). The
phone sheets are unchanged.

## The idea

HADAL is the deepest zone of the ocean, and the place you descend into. The interface says so with three things:

- **Depth.** Surfaces are plates, not tiles: `--h-depth-0` (#0a1014) is the field behind everything,
  `--h-depth-1` (#10181e) the working ground, `--h-depth-2` (#18242c) what is raised (cards, menus, fields).
  The field carries two still light pools (signal 6%, second voice 4%) and marine snow drifting down behind
  the windows (`web/atmosphere.js`).
- **Signal.** One accent, #65d9ff, the point of light at the bottom of the mark. It marks what is alive: focus,
  the active session, running, unread. It fills under 8% of any viewport and never decorates.
- **Instrument.** Figures in tabular IBM Plex Mono, sentence case everywhere, few boxes, one shadow used only
  by floating surfaces, no nested cards, no glow.

Inks, measured on the three depths (rendered pixels, re-measured on the Bell depths 2026-11-15): `--h-ink-1`
#e5f1fc (spoken) 16.7/15.6/13.8, `--h-ink-2` #91a9bc (beside it) 7.8/7.3/6.5; the two quiet texts are 94% of
ink-2 and hold 4.5:1+ on the three depths and on a selected row: `--h-ink-3` toward the field at 7.0/6.5/5.7,
and the `--muted` alias toward the working ground at 7.0/6.5/5.8. `--h-ink-mute` #5b7284 is never text
(3.8/3.6/3.2: disabled, placeholders, rules). On the raised fill (a selected segment) even ink-2 sits at 4.4:1,
so text there is ink-1 or a status color. Signal #65d9ff sits at 11.8/11.0/9.7, signal-2 #7fb2c8 at 8.3/7.8/6.9.
Status: ok #72e6c1, warn #f0c674, err #ff8a9b. State color is never the only signal: each state also has a
shape or a word.

## How it is built

- `web/tokens.css` (loaded first, in the `pocket` layer) defines the `--h-*` names: depths, inks, signal, status,
  space (2 4 8 12 16 24 40 64), corners (surface 6, control 3, chip 3 since Bell; 14/8/6 before), z steps, one
  shadow, and motion (120/220/420 ms, settle curve, exits at 70%).
- The palette engine is untouched: `theme.js` still writes the 17 `--o-*` variables, and `tokens.css` maps them
  into `--h-*`. The hadal palette (in `web/themes.js`) is the default (`DEFAULTS.theme`, `FALLBACK`, and the
  `style.css` literals); the earlier blue depths stay selectable as the `zone` palette, and every Omarchy palette
  and Follow desktop stay selectable. Browsers that had the old default migrate once via the `pocket.hadalLook`
  flag; a chosen palette is never touched.
- The old token names (`--bg`, `--card`, `--text`, …) are aliases of `--h-*` semantics in `style.css` `:root`,
  so every existing rule draws the new look. Rewritten sections use `--h-*` directly; an alias goes when its
  last use does.
- Type: Geist stays the interface face; `Pocket Mono` now serves IBM Plex Mono (code, commands, ids, figures,
  counts, keys). Weights stay 400/500/600.
- Glass (blur 18px saturate 1.15 over `--h-glass`) sits on menus and the launcher only, with an opaque fallback
  where `backdrop-filter` is missing. Floating surfaces get one hairline, a 1px top highlight, and the shadow.
- Focus: 2px signal outline on `:focus-visible`, never removed.

## Recorded waivers (PLAN.md D5)

1. Cyan on dark: required by the brand brief; held to the under-8% accent footprint.
2. Ambient illumination: the two light pools and the snow field are the brief's "light comes from what is
   alive"; nothing glows for decoration.

## Kept on purpose

The rail (its buttons, fold, and actions), the sessions list and its tabs and selection, sheets on phones and
wide screens, every shortcut, slash command, gesture, and panel in `docs/parity.md`. Nothing moved; nothing
was renamed.

## Bell (2026-11-15)

The operator picked concept **B** from the three in `docs/design/concepts/` (all three show the desk and the phone
side by side). Bell is the control-room reading of the same brief: environments lead, chrome reads like etched
metal, every figure is a readout, and the accent is phosphor on steel. What shipped today is Bell's skin; the
structure it describes is the next step.

Shipped with Bell, as the default palette and geometry:

- Depths are steel plates: #0a1014 / #10181e / #18242c (was the blue water #050d19 / #0d1b2c / #152b40, kept as
  the `zone` palette). Signal stays #65d9ff; signal-2 moves from violet #9b8aff to steel teal #7fb2c8, so the
  plate holds one cool cast. Selection #1d3040, mute #5b7284.
- Corners drop to the etched set: surface 6px, control 3px, chip 3px. Pills and avatars stay round; the 999px
  radii in `style.css` are status dots and avatars.
- The `hadal` palette entry, the `tokens.css` fallbacks, the `style.css` literals, the launcher icon
  (`app-icon.js`), `index.html`, the PWA manifest, and `site/hero.svg` all carry the steel values; every ratio
  in the table above is measured on the rendered page after the switch.

### The environments-first navigator (2026-11-15)

Bell's structure, first layer, landed: the navigator leads with environments. The session list's Folders grouping
is the default now (was Recent), so a browser that has never chosen a grouping opens on the environment tree, and
the Folders tab is where environments live. Each environment is a row: its light (the signal while HADAL works in
it, warm while a session there waits, failed, or waits on a limit, quiet otherwise), the folder's path with its
last part bold, the session count, and the fold. Its sessions nest under it, set in beside a hairline that runs the
column. Selection, drag, fold, search, pinned, and archived are untouched: the change is how the folder groups
render, not how the rows behave. Measured on the rendered copy at 1440, 960, and 390: no document overflow, no
clipped environment row or light, the nesting holds at every width.

### The readout rail (2026-11-15)

Bell's structure, second layer, landed: the top bar reads as a control room. Beside the title, before the action
buttons, an etched rail carries the session's live figures: the environment's light (the same states the navigator
tree uses), the model, the thinking level, a ten-step context meter with its percent, the spend, the live line (the
signal while HADAL works), and the people here. Every value is the store's own, the same figures the status line
under the message box shows, so the rail is always what the session is. It is driven by the bar's own width, not
the viewport, because tiling narrows the pane: it shows when the bar has room for it, drops the extras (thinking,
the live line) below that room, and is hidden on a phone, where the status line is the readout. Measured on the
rendered copy: no overflow at any width, the meter fills step by step, and the light renders in all three states.

### The console-tray composer (2026-11-15)

Bell's structure, third layer, landed: the message box reads as a console. Its controls are etched, mono knobs on
hairlines instead of pills. The model is a labeled knob, `model` boxed on the left with the value and its chevron to
the right (the sparkle that sat there is gone); the plan, the browser, and the subagents' models are quiet knobs like
it, each taking the signal and a quiet tint when on. The label steps out on a narrow box, where the value is what
matters; the value clips, never the label. Everything else about the box is untouched: send, steer and queue, the
mic, attach, drafts, the queue, the held line, the status line. The chrome stays quiet steel and one accent, the
signal, on the send; the richness is in the knobs, not a glow. Measured on the rendered copy at desk and phone, and
again with HADAL working: no overflow at any width, the label shows where there is room and the value clips where
there is not.

### Panels dock as portholes (2026-11-15)

Bell's structure, fourth layer, landed: a panel sits beside the transcript on a wide screen as a porthole cut into the
plate, and covers it as a screen only below 1100px. (The dock itself was already there; this is its look.) Its cap is a
header on a hairline, tight as the readout rail: the Files / Changes switch is an etched, mono segmented control on a
hairline, the same knob as the console tray, not a filled track, and the changed-file count is an etched chip that
lights only where a change waits. The folder path reads in quiet mono; the close is a quiet icon. The Browser panel and
an extension's panel share the dock, the cap height, and the segmented controls, so all three portholes read as one
family. On a phone they stay sheets. Measured on the rendered copy docked (1440) and covering (1000): the cap holds,
the switch is mono, the path clips and never overflows, and the count lights on a change.

### The aligned call log (2026-11-15)

Bell's structure, fifth layer, landed: a run of HADAL's tool calls reads as one aligned log. The kind holds a single
fixed column (wide enough for a tool and its action, e.g. `Subagent run`), so the argument and the result line up
down every row of the group, not drifting by the width of the word before them. The argument column takes the room and
clips; the result sits at the right in tabular figures, lit by how the call went (green added, red removed, the signal
while a call runs, red on an error). The status mark stays on the timeline rule, so the log keeps its affordance: a
call that failed still reads at a glance. A longer kind (an extension's own name) ellipsizes; the argument always
carries the detail. Measured on the rendered copy at 360 to 1200px: no document overflow, no clipped head, the kind
column uniform and the argument aligned at every width.

### The live log and images (2026-11-15)

The transcript's own surface moved to the log language. A line from you no longer floats as a right-aligned chat
bubble: it sits flush to the left like every other row, marked by a quiet signal rule and a fainter plate tint, so the
column reads down one edge. The raised card and its corners are gone; the read time stays in the line.

An image a read returned now shows live under its line the moment the model sees it, the way a browser shot already
did. Before, a read's image stayed folded inside the call until you opened it, so "the model is looking at a picture"
gave no sign. The thumbnail rises in with a brief signal edge as its call settles; the same image from a session opened
earlier stays still, so scrolling a transcript never replays it. A read's image shows once, not also inside the opened
body.

Following a live session eased in place of snapping: as a streamed line or an arriving image grows the transcript, the
view glides down on the catch-up's curve instead of jumping a step for each update. It steps aside for a catch-up's
glide, jumps at once where motion is reduced, and jumps rather than chases a drop of more than a few screens. The
"to the bottom" button still goes down at once. Measured with the live app and the read-image UI test (the picture
shows under the closed read, once): check clean, transcript, entry, prompt, browser, design, extension suites green.

### Hosts in the log (2026-11-16)

A session can work on other machines (`hosts.ts`): bash, read, write and edit take an optional `host`, and a workspace
address (`ssh://gpu/…`) puts a whole session there. The interface now says where each call ran, in the same log language
as the rest of Bell.

- A call that leaves this machine shows an etched `@gpu` tag after its kind, in the aligned call log and in a folded
  group's line (two tags, then `+n`). The tag is 10.5px mono, a hairline, the raised ground at 45%, and clips at 11ch
  rather than pushing the argument out. A local call shows none: this machine is the default, and the run log names it.
- The readout rail gains a `host` cell between the environment light and the model: the remote host reached most
  recently, `+n` for the others, the signal while HADAL works there now, and a `!` in the error color when a call there
  failed. The rail hides it with its extras, so the title keeps its room in a narrow pane; the status line shows the
  same figure as an etched chip on every width. Both open the run log.
- **Where commands ran** (`sheets/host-runs.js`) is the trace: the summary filters are the machines (All, here, each
  host, with counts and failures), the rows are the session's calls newest first, and each row opens its call in the
  transcript. A row has the state mark, the host, the tool, the argument, the duration, and the time; a failure prints
  its first line under it. A call with no result after its run is over shows a dash, not a spinner. The host a workspace
  session runs in is named even when a call gives no `host`. `!` commands are rows too, on this machine. One page is 80
  rows, with older runs on request.
- **Hosts** (the owner's sheet) keeps its place and gains the machine's name, mode counts, one plate for the list with a
  hairline between hosts, mode chips, the last test's time and folder, and **Test all**. The form leads with the ssh
  details and keeps the mode control.

Measured on the rendered copy at 1440, 960 and 390: no horizontal document overflow; the tag is 37px wide for `@gpu`;
filter chips are 30px (40px on a coarse pointer); run rows are 38px (40px on a phone); the phone's kind column drops to
10ch and the result to 30% so the argument keeps room beside the tag. The run log's data is `web/host-runs.js`, pure and
tested in Node (`test/host-runs.test.ts`); `test/host-runs-ui.test.ts` checks the tags, the group line, the rail, the
log's rows and its host filter in Chromium, and the phone's status line with the chip.

## Deferred

- U2 shell: dock, navigator, stage, inspector, command surface (PLAN.md section 4).
- Capabilities and Activity hubs, Atlas (PLAN.md section 4), the four-place navigation, and the owner default
  for new browsers (`themeDefault`) following the owner's palette automatically.
- A type scale for the ~300 remaining font sizes, and restyle of the extension gallery's internals.

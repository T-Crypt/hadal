# Phone UI review (2026-11-17)

What was checked, how, and what came of it. The checks ran against a throwaway server on `:8798` (`--data /tmp/hadal-ui-test`),
with headless Chromium at 390x844 and 320x700, touch and coarse pointer emulated, signed in with the server's owner
token. Screenshots: `/tmp/phone-atlas.png`, `/tmp/phone-session.png`, `/tmp/phone-session2.png`.

## What holds up

- **No horizontal overflow** at 390 or 320: `documentElement.scrollWidth` equals `clientWidth` on the Atlas and the
  session screen.
- **Safe areas** are handled: `env(safe-area-inset-*)` is used by the top bar, the rail, the dock, and the composer
  (`style.css` around lines 912 to 1077 and 4147).
- **The keyboard does not zoom the fields**: every field is 16px on a coarse pointer (`style.css:442`), and the composer
  textarea computes to `16px`.
- **Touch targets**: the composer's round buttons are 32 to 36px on screen, but each has a `::before` hit layer
  (`style.css:17121` onward) that takes a tap about 40 to 44px wide and tall, so the visual density does not cost a
  thumb's accuracy. Chips reach further up and down for the same reason. This is deliberate and correct.
- **Transcript and command surface** fit a 390px column: composer controls on one row, status line under it, no clipped
  control except the model name (below).
- **Keyboard hint hidden on touch**: the search field's shortcut and launcher hints are CSS-hidden under
  `pointer: coarse` (`style.css:13463`).

## What was fixed

- **The model chip clipped its own value.** With no model picked, the chip read `no mo…` at 390px, because the `model`
  label hides under 452px and the value had about 52px. It now says `none`, which fits, and the chip keeps its
  `aria-label` and title ("Model: No model"). One line in `web/composer.js`.

## Findings left open

1. **The navigator is wide on a phone.** On the Atlas at 390px the session list sits beside a 99px column (the
   navigator), about a quarter of the screen. It is usable, and a drawer is one tap away, but the list would read better
   at full width with the navigator behind the drawer by default under 700px. This is a layout decision, so it was not
   changed here.
2. **A long branch name truncates in the top bar** (`feat/host-run-visi…`). Acceptable, and the full name is in the
   title, but a shorter form (`host-run-visi`, without the prefix) would read better.
3. **The empty state is one sentence** and names the action ("Start one with New."). Good; no change.

## How to re-run

```sh
node bin/hadal.js --access local --port 8798 --data /tmp/hadal-ui-test --yes     # background it
# then the two scripts used here: /tmp/shot-session.mjs and /tmp/measure-phone.mjs
```

They log in through `/login?token=<owner token>`, open `/s/<id>`, wait for the app, take a PNG, and print element
boxes and console errors. `web-shot`'s own script waits for `networkidle`, which never comes on this app because the
event stream stays open: use `domcontentloaded` plus a wait instead.

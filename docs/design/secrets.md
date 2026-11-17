# Secrets that never reach the model

Design, 2026-11-17. A person pastes a token into a session, and HADAL keeps it for use in commands without the model,
the provider, the transcript or the session's people ever seeing it. It is not a vault for its own sake: it exists
because a token typed into a message today is sent to the provider, stored in the database, and read by everyone in
the session.

## The problem, in one example

An npm token was pasted into a session to set a GitHub secret. That message went to the model provider, sits in
`hadal.sqlite`, and is readable by every person in the session. The only remedy now is to roll the token. Every
person who does this once learns not to do it again, or learns nothing.

## Goal

- A pasted secret becomes a **named value** the person keeps, and the session holds `[npm token]` instead.
- The model sees the name, never the value.
- A command that needs it gets it as `$NPM_TOKEN` when it runs.
- Any occurrence in tool output, a later message, or a session title becomes `[npm token]`.
- Nothing is written in plain text: not the database, not the transcript, not a log, not a suggestion list.

## Non-goals

- **Not a boundary against the model.** A model that runs `printenv` or `base64` can leak an injected value. Masking
  stops accidents; it does not stop a hostile model. Say this where people save a value.
- Not a password manager: no sync, no sharing between people, no history of old values.
- Not protection from a command that writes the value to a file. HADAL masks text, not side channels.

## Where it lives

A built-in extension, `secrets`, off until the owner turns it on. It uses the members that already exist for values
that must not go through HADAL ([people-values.md](../extensions/people-values.md)):

- `host.commandEnv` to put the value in a command's environment,
- `host.hide` to mask the value in tool output, results, and people's messages,
- a prompt section that lists **names only**, so HADAL knows `$NPM_TOKEN` exists and what it is for.

No core route and no new tool are needed for the first slice. The store and the key are the extension's own files.

## Storage

| File                    | What it holds                                                                   |
| ----------------------- | ------------------------------------------------------------------------------- |
| `~/.hadal/secrets.json` | Names, owners, descriptions, and the values as AES-256-GCM ciphertext, mode 600 |
| `~/.hadal/secrets.key`  | The 32-byte key, generated on first use, mode 600                               |

- The key never leaves the server's data folder. It is not in `config.json`, the database, an export, or a backup
  that only copies the database.
- The extension holds the key in memory only while it encrypts or decrypts. It never prints it.
- A value belongs to the person who saved it. Their sessions and their subagents get it; nobody else's do, except the
  owner, who may see the names and not the values.
- Deleting a value removes its ciphertext. Rolling it replaces it under the same name, so a command that uses
  `$NPM_TOKEN` keeps working.

## What a person does

1. Paste the secret into the message box. A strip under it says **This looks like a secret** with two choices:
   **Save as a secret** and **Send it as text**.
2. **Save as a secret** asks for a name (filled in from the prefix: `npm`, `github`, `openai`) and an optional note,
   then replaces the pasted text with `[npm token]` and saves the value.
3. The message that goes has `[npm token]`. The person can also type `[npm token]` themselves later.
4. **Saved secrets** in the sheet lists the names, what each one is for, and when it was last used, with **Roll** and
   **Forget**. It never shows a value again.
5. The prompt section tells HADAL: `$NPM_TOKEN` exists for "publish to npm"; use it in commands; never print it.

`hadal cli` gets the same list through the same routes, and `/secret name` prompts for a value without echoing it.

## Files and changes

| Part                                 | What it does                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/server/extensions/secrets.ts`   | The store, encryption, `host.commandEnv`, `host.hide`, the prompt section, the routes                             |
| `src/server/extensions/secrets/*.js` | The browser side: the paste strip, the save card, the saved-secrets sheet                                         |
| `web/composer.js`                    | One extension point: `onPaste(text, { replace })`, so the browser module can offer to save without owning the box |
| `src/server/http/api.ts`             | Nothing for the first slice: the extension adds its own routes                                                    |
| `test/secrets.test.ts`               | Encryption round trip, the owner rule, the command environment, masking in results and messages, a restart        |

## The first slice, and what proves it

**Slice 1, the store and the environment.** A saved value (from the card, no paste detection), `host.commandEnv`, the
prompt section, and the sheet. Prove it: save a token, run `curl -H "Authorization: Bearer $NPM_TOKEN"`, and check
that the value is in the command's environment, is absent from the stored transcript and the database file, and is
masked in the output.

**Slice 2, the paste strip.** Detection and replacement in the composer, and `host.hide` registered at startup so an
old value is masked wherever it turns up. Prove it: paste a test token, save it, and grep the database, the logs and
the provider payload for the plain text.

**Slice 3, the rest.** Rotating, last used, the CLI `/secret`, the audit line in the session's activity.

## Detection rules, kept small

A paste is offered as a secret when it is one token, 20 characters or more, no spaces, and matches a known prefix
(`npm_`, `ghp_`, `github_pat_`, `sk-`, `xoxb-`, `AKIA`, `glpat-`, a JWT's three parts) or has at least 16 characters
from mixed classes with no vowels in a row. A false offer is cheap (one tap to send as text); a missed one costs a
roll, so err toward offering. Never detect in the middle of a sentence, and never scan a whole message.

## Risks this design accepts

- The server process can read the key, so anyone with that shell can read the values. Same trust as the data folder.
- A model can print an injected value. Masking catches the plain text in the result; it will not catch an encoded
  form. The value's note says "not a boundary against the model".
- A backup that copies the whole data folder copies the key. It is a file, and files can be backed up.
- The composer's paste detection sees the text before it is sent. It runs in the page, so a compromised extension in
  the same page could read the paste. Extensions already run with the page's access; say so.

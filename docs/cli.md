# The terminal client

`hadal cli` is a tab in a HADAL session. It is not a second app: it signs in to the same server, uses the same
database, and speaks the same tab protocol a browser does. A run started in the terminal goes on when the terminal
closes, and opens in the browser at `/s/<id>`.

## Run it

```bash
hadal cli                     # join the last session you used here, or start one
hadal cli --session 12        # join session 12 (the one in the browser at /s/12)
hadal cli --new               # start a session in this folder
hadal cli --list              # the sessions, with a terminal or browser mark, and exit
hadal run -p "run the tests"  # send one message, wait for the run, and exit
```

`hadal` alone and `hadal serve` still run the launcher.

## Where it runs

On the server's machine, the CLI signs in with the owner token in the data folder, so there is nothing to set up.

On another machine, pass the server's address and a token:

```bash
HADAL_TOKEN=… hadal cli --server http://workstation:8787
```

Use a browser sign-in token for a limited role, or the owner token for the owner's rights. A token on a command line
is visible to other processes on that machine; the environment is not much better, so use a machine you trust, or a
sign-in token that you can revoke.

## What it does with the server

- With nothing answering on the port, it starts the launcher, waits until it answers (90 seconds at most), and stops
  it on the way out.
- `--leave` keeps a server it started running after the CLI exits. That server runs detached, so closing the terminal
  does not stop it, and it logs to `cli-server.log` in the data folder.
- `--no-start` makes it report that no server answers instead of starting one.
- `--data DIR` uses another data folder, the same one the launcher takes with `--data`.
- It holds neither `launcher.lock` nor `harness.lock`: it can run beside `hadal serve` and any number of browsers.
- A session the CLI made carries `client: "terminal"`, which the session list shows as a `terminal` chip.

## The stream

The tab connects to `/api/events` for its session. When the stream drops (a restart, a sleeping laptop, a network
change), the CLI reconnects after 1 second, then 2, 4, and so on to 30 seconds, and says so. Each reattach starts with
the session's full view, so nothing that happened meanwhile is lost. A refused token (401 or 403) is not retried.

The run lives on the server. Ctrl+C detaches and prints `hadal cli --session <id>`; the run goes on.

## What it draws

- Your message, then the answer as it is written.
- Each tool call on one line, then a line with its result: `✓ read a.ts`, or `✗ bash: exit 1` with the first line of
  the error.
- A failed run in red, with the model's error.
- An approval as a card with `y` and `n`. An approval that needs typed fields says to answer it in the browser.
- A status line on the terminal's last row while the run works: seconds, calls so far, and the model. It counts on its
  own, once a second. No status line when the output is not a terminal, and `NO_COLOR` or `TERM=dumb` turns colour off.

Keys and commands:

| Input   | What it does                                   |
| ------- | ---------------------------------------------- |
| `y`/`n` | Allow or deny the waiting approval             |
| `/stop` | Stop the run                                   |
| `/open` | Print the browser address of the session       |
| `/exit` | Detach (the run goes on)                       |
| Ctrl+C  | Detach, and stop a server this command started |

## Exit codes

| Code | `hadal run`                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 0    | The run finished, and its answer has no error                                                        |
| 1    | The run failed, the message did not reach the server, or there is no session, token or server to use |
| 2    | An option it does not know                                                                           |
| 130  | Interrupted (Ctrl+C or a signal)                                                                     |

`hadal run` waits while the server retries an attempt or waits out a provider's limit. A run that fails after its
retries exits 1. There is no default timeout: a long run is a real run. Use `timeout` when a script needs one.

## The files it keeps

In the data folder (`~/.hadal`, or `HADAL_DIR`, or `--data`):

| File               | What it holds                                                      |
| ------------------ | ------------------------------------------------------------------ |
| `cli.json`         | The last server address, and the last session it joined            |
| `cli-session.json` | A sign-in token kept from `--token`, so the next run needs no flag |
| `cli-server.log`   | The output of a server this command started                        |

The owner token itself stays in `config.json`, where the server keeps it.

## What it does not do yet

- No full-screen interface: it prints lines, and the shell keeps the scrollback.
- No files panel, diff review, subagents board, or browser panel.
- No approvals with typed fields; those say to answer in the browser.
- No `--json` output; `run` prints lines for a person.

The design, the action-to-route list and the build notes are in [design/cli.md](design/cli.md),
[design/cli-contract.md](design/cli-contract.md) and [design/cli-implementation-notes.md](design/cli-implementation-notes.md).

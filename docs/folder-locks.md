# Folder locks

A locked folder is one that only the models its policy allows may see. The strictest policy allows local models
only. The others allow local models plus Claude, plus US cloud models, or plus a set of US companies you pick.

Lock a folder whose contents must not reach a model you do not trust, such as a client's notes or a private
repository. HADAL keeps the folder on your own machines and on the cloud companies its policy names.

## What a lock does

- **A session that works in the folder is sealed to the lock's policy.** It may send requests only to models the
  policy allows. The model picker shows the other models, but you cannot pick them, and the server refuses a
  request to one before anything is sent. A seal lasts: moving the session to another folder, or unlocking the
  folder later, does not let its transcript reach a model the policy did not allow.
- **A seal narrows, never widens.** A session that moves into a stricter folder, or reads a session sealed to a
  stricter policy, keeps the narrower policy.
- **Subagents of a sealed session are sealed with it**, wherever they work.
- **Every other session cannot see the folder.** Its file tools refuse any path that leads into it, symlinks
  included. Its commands (the shell, `!` commands, checks, background tasks) run in a
  [bubblewrap](https://github.com/containers/bubblewrap) sandbox in which the folder is an empty directory.
- **A sealed session cannot reach another machine through `host`.** Its SSH host calls are refused, because the
  lock cannot see what a remote path holds.
- **Lantern and other sessions get only what they may see.** A sealed session shows as "Locked session" in
  Lantern's list. A sealed session's waiting calls show the tool but not the command. Its reports, and its messages
  to linked sessions, say only that it answered, unless the receiving session runs on a model the policy allows.
  Reading a sealed session seals the reader to its policy.
- **Lessons stay put.** A lesson saved in a sealed session applies only in sealed sessions.

## Which models count as local

A model is local when every address its host resolves to is on this machine (127.0.0.0/8, ::1), the LAN (10/8,
172.16/12, 192.168/16, link-local), or the tailnet (100.64/10, fd00::/8). A provider's own API is not local. A
tailnet name that resolves to a public address, such as a Tailscale Funnel, is not local. HADAL looks names up
again every ten minutes.

A local model is allowed by every policy, whatever its maker, because no data leaves your machines.

## Which cloud models a policy allows

The policy names a scope:

| Scope       | Allows                                             |
| ----------- | -------------------------------------------------- |
| `local`     | Local models only.                                 |
| `anthropic` | Local models and Anthropic.                        |
| `us`        | Local models and the US companies in the registry. |
| `custom`    | Local models and the US companies you pick.        |

`src/server/model-origin.ts` maps a provider and a model id to a company and a region. The check uses the maker
and the model family, not the IP address of the API. A US gateway such as OpenRouter or OpenCode Go can serve a
Chinese model, so the model decides, not the gateway.

- A model id with a vendor prefix uses that vendor: `deepseek/...`, `anthropic/...`.
- A model family in the id is next: `claude`, `gpt`, `gemini`, `grok`, `deepseek`, `qwen`, `glm`, `kimi`,
  `minimax`, `seed`, `hunyuan`, `longcat`, `mimo`, `ernie`, `step`, `mistral`, `command`, and others.
- The provider id is the fallback.
- **A model that is not in the registry is unknown, and unknown models are refused in a locked folder.** A new
  model stays blocked until a person reviews its maker and adds it. The registry carries the date it was last
  reviewed.

A US company that hosts a non-US model does not make the model US. The maker decides. An aggregator that routes
to a provider you did not choose is allowed only when the model itself is on the US list.

## Remote copies

A lock can name a copy of the folder on another machine: `host: "aphotic", path: "/home/tcrypt/Work"`. The host
is a name from Menu -> Hosts. The path is absolute and uses `/` separators; a Windows path is not supported.

- **A sealed session** may use `host: "aphotic"` for `read`, `write`, and `edit` only inside the mapped path. A
  path outside it is refused. The session's model policy still applies.
- **A session outside the lock** is blind to the mapped path: `read`, `write`, and `edit` there are refused.
- **A command on that host asks a person first.** `bash` has no path, so HADAL cannot prove it stays inside. The
  approval card shows the command. A person's answer is a guard, not a boundary; a command can still read what its
  user can read.
- A remote copy has the protections of its own machine. HADAL does not sandbox another machine.
- The sheet's **Remote copy** fields set one mapping. The API takes `remote: [{ host, path }]`.

## What the sandbox hides from other sessions

Besides the locked folder, the sandbox hides what holds copies of it, or offers a way around the sandbox:

- HADAL's database and the uploads of sealed sessions. The rest of the data folder stays: extensions, themes,
  routers, agents, worktrees.
- Other harnesses' session logs for the folder (Pi, DSH, OMP, Claude Code), found by the names those harnesses give
  them, and any path you add as `hide` when you lock.
- Git worktrees of a locked repository under HADAL's `worktrees` folder. These count as inside the lock, so a
  session working in one is sealed to the same policy.
- SSH keys and the SSH agent (so `ssh localhost` cannot read the folder), the user's D-Bus (so `systemd-run --user`
  cannot), and tmux and screen servers.

Every sandboxed command also runs in its own user namespace, which keeps it out of other processes'
`/proc/<pid>/root`.

A session working in a locked folder runs its commands with the lock file read-only, so it cannot unlock its own
folder.

## Limits

- **Loopback services.** The sandbox shares the network. A service on this machine that runs commands or reads
  files for anyone who asks, without a sign-in, is a way around it.
- **Commands can call any API.** The gate covers HADAL's model requests. A command with a key can still send data
  to a provider the policy blocks. A range VM with a network allowlist is the boundary for that.
- **SSH-host workspaces** run on another machine and are not covered. A remote copy is covered by the `host`
  paths above; a workspace provider is a separate path.
- **Other harnesses** (Claude Code, Codex, OpenCode, DSH) do not read this lock. They need their own rule.
- **Git over SSH** does not work from a sandboxed session while a folder is locked, because its keys are hidden.
  Use HTTPS (for example `gh auth`) there.
- **A race in the file tools.** The file tools check a path before and after each call. A command that swaps a
  symlink at exactly the right moment could still slip one read through. The shell has no such gap, because the
  sandbox enforces it in the kernel.
- **No sandbox, no commands.** Without bubblewrap, a session outside a locked folder cannot run commands at all
  while a lock exists. HADAL refuses rather than run them unguarded.
- **A lock works from the moment it is set.** What reached a model before then stays with that provider.

## Using it

- In the session list's **Folders** tab, the owner sees a lock button at the right of each environment row. Press
  it to open the folder lock sheet. The sheet chooses the policy, shows which companies it allows and blocks, and
  takes the paths of copies to hide.
- A locked environment shows a chip with its policy: `local`, `claude`, `us`, or `custom`. A sealed session shows
  the same in the top bar.
- The API (owner only):
    - `GET /api/folder-locks`
    - `POST /api/folder-locks/lock` with `{ "path": "/abs/folder", "policy": { "scope": "us" }, "hide": ["/other/copy"], "remote": [{ "host": "aphotic", "path": "/home/tcrypt/Work" }] }`
    - `POST /api/folder-locks/policy` with `{ "path": "/abs/folder", "policy": { "scope": "anthropic" } }`
    - `POST /api/folder-locks/unlock` with `{ "path": "/abs/folder" }`
- A policy is `{ "scope": "local" }`, `{ "scope": "anthropic" }`, `{ "scope": "us" }`, or
  `{ "scope": "custom", "companies": ["Anthropic", "Google"] }`. A custom company must be on the US list.
- The state is kept in `folder-locks.json` in the data folder. Version 1 of the file, which had no policies, reads
  as `local` for every lock and every sealed session. HADAL writes version 2. If HADAL cannot read the file, every
  request to a model that is not local fails until the file is fixed.

Code: `src/server/model-origin.ts` classifies the makers. `src/server/folder-lock.ts` keeps the locks, the seals,
and the gate, which `app.ts` installs. Tests: `test/model-origin.test.ts`, `test/folder-lock.test.ts`, and
`test/folder-lock-app.test.ts`.

# Folder locks

A locked folder is one that only local models may see. Lock a folder whose contents must not reach a cloud
model, such as a client's notes or a private repository, and HADAL keeps them on your own machines.

## What a lock does

- **A session that works in the folder is sealed.** It may send requests only to a model on this machine, your LAN,
  or your tailnet. The model picker shows the other models, but you cannot pick them, and the server refuses a
  request to one before anything is sent. A seal lasts: moving the session to another folder, or unlocking the
  folder later, does not let its transcript go to a cloud model.
- **Subagents of a sealed session are sealed with it**, wherever they work.
- **Every other session cannot see the folder.** Its file tools refuse any path that leads into it, symlinks
  included. Its commands (the shell, `!` commands, checks, background tasks) run in a
  [bubblewrap](https://github.com/containers/bubblewrap) sandbox in which the folder is an empty directory.
- **Lantern and other sessions get only what they may see.** A sealed session shows as "Locked session" in
  Lantern's list. A sealed session's waiting calls show the tool but not the command. Its reports, and its messages
  to linked sessions, say only that it answered, unless the receiving session runs on a local model. Reading a
  sealed session seals the reader.
- **Lessons stay put.** A lesson saved in a sealed session applies only in sealed sessions.

## Which models count as local

A model is local when every address its host resolves to is on this machine (127.0.0.0/8, ::1), the LAN (10/8,
172.16/12, 192.168/16, link-local), or the tailnet (100.64/10, fd00::/8). A provider's own API is not local. A
tailnet name that resolves to a public address, such as a Tailscale Funnel, is not local. HADAL looks names up
again every ten minutes.

## What the sandbox hides from other sessions

Besides the locked folder, the sandbox hides what holds copies of it, or offers a way around the sandbox:

- HADAL's database and the uploads of sealed sessions. The rest of the data folder stays: extensions, themes,
  routers, agents, worktrees.
- Other harnesses' session logs for the folder (Pi, DSH, OMP, Claude Code), found by the names those harnesses give
  them, and any path you add as `hide` when you lock.
- Git worktrees of a locked repository under HADAL's `worktrees` folder. These count as inside the lock, so a
  session working in one is sealed.
- SSH keys and the SSH agent (so `ssh localhost` cannot read the folder), the user's D-Bus (so `systemd-run --user`
  cannot), and tmux and screen servers.

Every sandboxed command also runs in its own user namespace, which keeps it out of other processes'
`/proc/<pid>/root`.

A session working in a locked folder runs its commands with the lock file read-only, so it cannot unlock its own
folder.

## Limits

- **Loopback services.** The sandbox shares the network. A service on this machine that runs commands or reads
  files for anyone who asks, without a sign-in, is a way around it.
- **SSH-host workspaces** run on another machine and are not covered.
- **Git over SSH** does not work from a sandboxed session while a folder is locked, because its keys are hidden.
  Use HTTPS (for example `gh auth`) there.
- **A race in the file tools.** The file tools check a path before and after each call. A command that swaps a
  symlink at exactly the right moment could still slip one read through. The shell has no such gap, because the
  sandbox enforces it in the kernel.
- **No sandbox, no commands.** Without bubblewrap, a session outside a locked folder cannot run commands at all
  while a lock exists. HADAL refuses rather than run them unguarded.
- **A lock works from the moment it is set.** What reached a cloud model before then stays with that provider.

## Using it

- In the session list's **Folders** tab, the owner sees a lock button at the right of each environment row. Press
  it to lock or unlock the folder. A locked environment shows a green `local` chip, and a sealed session shows
  `seal local` in the top bar.
- The API (owner only): `GET /api/folder-locks`, `POST /api/folder-locks/lock` and
  `POST /api/folder-locks/unlock`, each with `{ "path": "/abs/folder", "hide": ["/other/copy"] }`.
- The state is kept in `folder-locks.json` in the data folder. If HADAL cannot read that file, every request to a
  model that is not local fails until the file is fixed.

Code: `src/server/folder-lock.ts`, with the gate installed in `app.ts` and the checks in `pip.ts`,
`linked-sessions.ts`, `memory.ts` and `background.ts`. Tests: `test/folder-lock.test.ts` and
`test/folder-lock-app.test.ts`.

# Local mode

Local mode is the **zero-config** flavor: multiple Claude Code sessions on **one
machine** coordinate through a shared SQLite file. No server, no auth, no setup.

If you don't provide a team API URL and key, the plugin runs in local mode
automatically.

## Install

Install the `continuity` plugin in Claude Code. That's it — leave the plugin's
`apiUrl` and `apiKey` config blank and Continuity runs locally. The plugin launches the
bundled shim (`plugin/mcp/index.mjs`) on session start.

> The bundled shim uses Node's built-in `node:sqlite` — **no native dependencies**,
> so the committed bundle is pure JS and works on any OS/arch.

Requires **Node ≥ 22** (`node:sqlite`). The launcher passes `--experimental-sqlite`,
which is required on Node 22.x–23.x and a no-op on Node 24+.

## Where the database lives

By default the SQLite file is at:

```
~/.continuity/continuity.db
```

It's created automatically the first time the shim runs in a git repo — there is no
migration step. Override the location with the `dbPath` plugin config (passed to the shim
as `CONTINUITY_DB_PATH`):

```
~/.continuity/continuity.db        # default
$CONTINUITY_DB_PATH                # override via the plugin's dbPath config
```

One database file backs all your local sessions, across repos.

## What works

Local mode is the **coordination core** — the full set of MCP tools:

- **Presence** — `agent_list_active`, `agent_get`, `agent_report_focus`,
  `agent_file_activity_recent`. See who else is working right now, what they're focused
  on, and which files have been touched recently.
- **Decisions** — `decision_write`, `decision_recent`, `decision_get_by_key`,
  `decision_supersede`. Typed, append-only shared decisions. A duplicate
  `decision_key` comes back as a **conflict** (the existing decision), never a silent
  overwrite.
- **Task claims** — `task_claim`, `task_update`, `task_release`, `task_complete`,
  `task_list`. Atomic "I've got this issue" claims. If another session already holds the
  claim, `task_claim` returns a **conflict** with the existing claim.
- **Handoffs** — `handoff_create`, `handoff_pending`, `handoff_accept`,
  `handoff_complete`. Structured context transfers between your sessions.

The **SessionStart snapshot** runs in local mode too: every new session prints who's
active, recent file activity, recent decisions, and any pending handoffs.

## What doesn't (local is core-only)

These team-flavor extras are **not** available locally — they require the team server:

- GitHub Projects integration (no `github_*` tools)
- plan-check
- Slack escalation

In local mode you claim work with `task_claim` (by repo + issue number) rather than any
GitHub-specific tooling.

## How parallel sessions coordinate

All local sessions open the same SQLite file with **WAL** (write-ahead logging) and a
`busy_timeout`, so concurrent reads and writes from separate shim processes are safe.
You can run as many sessions as you like — across worktrees, terminals, or tabs — and
they all see one shared view.

Atomic claims are enforced by a partial unique index plus `INSERT ... ON CONFLICT`: if
two sessions race to claim the same issue, exactly one wins and the other gets a conflict
result.

Because there's no background process locally, expiry is **lazy**: a session's status
(active / idle / gone) is computed from its last-seen time on read, and a throttled sweep
on checkin/heartbeat releases expired claims and prunes old file activity. A crashed
session naturally reads as gone without anyone cleaning up.

## The repo gate

Continuity installs user-wide but stays **inert** outside git repos. With the default
(empty) `repoAllowlist`, it activates in **any git repo** you run Claude Code in — and
does nothing in a non-git directory. To scope it to specific repos instead, set
`repoAllowlist` (see [`examples/arlo.md`](./examples/arlo.md)); that's primarily a team
concern.

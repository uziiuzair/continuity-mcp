# Plugin validation checklist

Automated tests cover the shared query logic and the backends, but they **cannot
exercise the live Claude Code plugin harness** — the MCP handshake, the
SessionStart context injection, or the hook events. This checklist is the manual
pass a maintainer should run in a **real Claude Code session** before tagging a
release.

Run it for the **local** flavor first (zero-config), then the **team** flavor.

> ⚠️ **Read this first — unverified assumptions.** Several hook event names and one
> payload shape were copied from an internal (Arlo) deployment and have **not** been
> confirmed against the public Claude Code harness:
>
> - The non-standard event names `CwdChanged`, `WorktreeCreate`, `WorktreeRemove`,
>   `TaskCreated`, and `TaskCompleted`.
> - The `UserPromptSubmit` payload (whether the prompt text actually arrives in the
>   shape the focus-sync hook expects).
>
> A hook wired to a **wrong/nonexistent event name silently no-ops** — Claude Code
> never fires it, the hook script never runs, and nothing errors. So "no error" does
> **not** mean "working." Each hook below has an explicit *confirm* step and a
> *"broken" looks like* note. If a hook can't be confirmed to fire, treat its event
> name/payload as **unverified** and file it against the live harness docs.

---

## 0. Prerequisites

- [ ] **Node ≥ 22** and **pnpm 9** installed (`node --version`, `pnpm --version`).
- [ ] Repo cloned; `pnpm install` succeeds.
- [ ] `pnpm -r typecheck` and `pnpm -r test` are green.
- [ ] Plugin payload built/up to date: `pnpm --filter @continuity/mcp build`
      (regenerates the pure-JS `plugin/mcp/index.mjs`). Confirm `node:sqlite` loads
      on Node ≥ 22 (the launcher passes `--experimental-sqlite` on 22.x–23.x).
- [ ] A throwaway **git repo** to test in (the gate is inert outside git).

---

## 1. Install the plugin in Claude Code

- [ ] Add the marketplace: `/plugin marketplace add uziiuzair/continuity-mcp` (or a
      local path to this repo).
- [ ] Install: `/plugin install continuity@continuity`.
- [ ] For **local** validation, leave `apiUrl` / `apiKey` **blank**.

**Confirm:** the plugin appears as installed and enabled.

---

## 2. MCP server connects and lists tools

Start a Claude Code session **inside the test git repo**.

- [ ] The Continuity MCP server connects (no handshake error).
- [ ] Its tools are listed. In local mode you should see the **17 coordination
      core** tools: `agent_list_active`, `agent_get`, `agent_report_focus`,
      `agent_file_activity_recent`, `decision_write`, `decision_recent`,
      `decision_get_by_key`, `decision_supersede`, `task_claim`, `task_update`,
      `task_release`, `task_complete`, `task_list`, `handoff_create`,
      `handoff_pending`, `handoff_accept`, `handoff_complete`, plus audit
      (`audit_recent`).
- [ ] The **team-only** tools (`github_*`, `plan_*`, `escalate`) are **absent** in
      local mode.

**Confirm inertness:** start a session in a **non-git** directory → the server
should run inert (handshake completes, **no** tools registered). This proves the
repo gate works.

**Broken looks like:** server fails to connect; tools missing in a git repo; or
team-only tools showing up in local mode.

---

## 3. SessionStart snapshot actually appears in context

The `SessionStart` hook should inject a coordination snapshot (who's active, recent
file activity, recent decisions, pending handoffs).

- [ ] Start a session in the test repo and confirm a **coordination snapshot is
      visible in the session context** at the top of the conversation (not just that
      the hook ran). Asking the model "what coordination context did you receive at
      session start?" is a quick way to confirm it actually landed in context.
- [ ] With a second session already active, the first session's snapshot should
      list the other active session.

**Broken looks like:** session starts with no snapshot in context (the
`SessionStart` event didn't fire, or `scripts/session-start.mjs` / the shim
`--snapshot` subcommand failed). Cross-check by running `agent_list_active` — if it
returns sessions but the snapshot never appeared, the hook (not the backend) is
broken.

---

## 4. Confirm each hook fires

For each hook, perform the trigger, then **confirm via a tool call or the DB** that
the effect landed. Inspecting the local DB is the ground truth:

```
~/.continuity/continuity.db          # default (or your dbPath override)
```

You can open it with any SQLite client and read `agent_sessions`, `file_activity`,
`decisions`, `task_claims`, `handoffs`, and `audit_events`.

### 4a. PostToolUse (file activity)

- [ ] Have the session **edit a file** (Write/Edit/MultiEdit/NotebookEdit) in the
      repo.
- [ ] Wait past the heartbeat/flush window (the shim flushes buffered paths to the
      backend roughly every 20–45s).
- [ ] **Confirm:** call `agent_file_activity_recent` (and/or
      `SELECT * FROM file_activity` in the DB) and see the edited path recorded for
      this session.

**Broken looks like:** the edit never appears in `file_activity` even after the
flush window — the `PostToolUse` matcher didn't fire, or the rendezvous buffer
never flushed.

### 4b. UserPromptSubmit (focus sync) — ⚠️ unverified payload

- [ ] Submit a distinctive prompt (e.g. "working on the auth refactor").
- [ ] **Confirm:** call `agent_get` for this session (or `agent_list_active`, or
      `SELECT focus FROM agent_sessions`) and verify the session's **current focus**
      now reflects the prompt text.

**Broken looks like:** focus never updates after submitting prompts. This is the
**most likely** assumption to be wrong — verify the `UserPromptSubmit` event name
**and** that the prompt text arrives in the payload shape the hook reads. If focus
stays empty/stale, the payload assumption is invalid; capture the actual harness
payload and fix the hook.

### 4c. SessionEnd (checkout)

- [ ] End the session cleanly.
- [ ] **Confirm:** from another session, `agent_list_active` should no longer show
      the ended session as active (or `agent_get` shows it checked out / gone). In
      the DB, its `agent_sessions` row should be checked out.

**Broken looks like:** the ended session lingers as "active" indefinitely (only
lazy expiry eventually cleans it up). That means `SessionEnd` didn't fire the
checkout.

### 4d. CwdChanged — ⚠️ unverified event name

- [ ] If reproducible, change the working directory within a session.
- [ ] **Confirm:** a fresh check-in for the new cwd (new/updated `agent_sessions`
      row keyed by `cwd_hash`; an `audit_events` entry may also appear).

**Broken looks like:** changing cwd produces no re-check-in. Treat `CwdChanged` as
unverified until confirmed against the live harness.

### 4e. WorktreeCreate / WorktreeRemove — ⚠️ unverified event names

- [ ] If reproducible, create a git worktree → expect a **re-check-in** for it.
- [ ] Remove the worktree → expect a **checkout**.
- [ ] **Confirm:** via `agent_list_active` / `agent_sessions` rows appearing and
      disappearing for the worktree's cwd.

**Broken looks like:** worktree create/remove has no presence effect — event names
unverified.

### 4f. TaskCreated / TaskCompleted (audit) — ⚠️ unverified event names

- [ ] If reproducible, trigger task creation and completion in the session.
- [ ] **Confirm:** call `audit_recent` (or `SELECT * FROM audit_events`) and see the
      corresponding `event_type` entries.

**Broken looks like:** no audit entries for task lifecycle events — event names
unverified.

### Hook summary

| Hook | Trigger | Confirm with | Status |
|---|---|---|---|
| `SessionStart` | start session | snapshot in context + `agent_list_active` | standard |
| `PostToolUse` | edit a file | `agent_file_activity_recent` / `file_activity` | standard |
| `UserPromptSubmit` | submit prompt | `agent_get` focus / `agent_sessions.focus` | ⚠️ payload |
| `SessionEnd` | end session | `agent_list_active` no longer shows it | standard |
| `CwdChanged` | change cwd | re-check-in row | ⚠️ event name |
| `WorktreeCreate` | create worktree | re-check-in row | ⚠️ event name |
| `WorktreeRemove` | remove worktree | checkout | ⚠️ event name |
| `TaskCreated` | create task | `audit_recent` | ⚠️ event name |
| `TaskCompleted` | complete task | `audit_recent` | ⚠️ event name |

---

## 5. Core coordination behaviors (local)

- [ ] **Atomic claim race:** from two sessions, `task_claim` the **same** repo +
      issue. Exactly **one** wins; the other gets a **conflict** with the existing
      claim. Verify only one live row in `task_claims`.
- [ ] **Decision conflict:** `decision_write` the same `decision_key` twice → the
      second returns a **conflict** with the existing decision (not an overwrite).
- [ ] **Supersede:** `decision_supersede` links the old decision and marks it
      superseded.
- [ ] **Handoff round-trip:** `handoff_create` → another session sees it via
      `handoff_pending` → `handoff_accept` → `handoff_complete`.
- [ ] **Lazy expiry:** kill a session abruptly (no clean SessionEnd); after the
      thresholds it should read as **gone** via `agent_list_active` without manual
      cleanup.

---

## 6. Team flavor validation

Run after local passes. See [`team-mode.md`](./team-mode.md) for full setup.

- [ ] **Deploy the server:** set `DATABASE_URL` (Neon **pooled**) and
      `API_KEY_HMAC_SECRET`, run migrations
      (`db:generate` / `db:push`), then `deploy` the Worker. Note the Worker URL.
- [ ] **Create a user:** run the `user:create` script; capture the raw API key
      printed **once**.
- [ ] **Point the plugin at it:** set the plugin's `apiUrl` (Worker URL) and
      `apiKey` (issued key). Restart the session.
- [ ] **Confirm team mode:** the MCP tool list now **includes** the team-only tools
      (`github_*`, `plan_*`, `escalate`) in addition to the core 17.
- [ ] **Cross-machine presence:** from a second machine/teammate key, `checkin` and
      confirm both sessions see each other via `agent_list_active`.
- [ ] **Exercise a team tool:** call a `github_*` and a `plan_*` tool end-to-end and
      confirm a sensible response from the Worker (not a local "tool not found").
- [ ] **Auth boundary:** a request with a missing/invalid `apiKey` is rejected.
- [ ] **Janitor cron:** stale sessions/claims are expired by the Worker cron (every
      minute) rather than lazily.

---

## 7. Sign-off

- [ ] All local checks pass (sections 1–5).
- [ ] All team checks pass (section 6).
- [ ] Any ⚠️ unverified hook either **confirmed working** against the live harness,
      or **filed as a known issue** with the actual event name/payload noted.
- [ ] `CHANGELOG.md` updated for the release.

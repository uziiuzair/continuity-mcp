# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> ⚠️ **Alpha.** Continuity is pre-1.0 and unstable. The schema, tool surface, wire
> format, and plugin may change without notice between alpha releases, including
> breaking changes that are not reflected in a major version bump.

## [Unreleased]

## [0.1.0-alpha.3] - 2026-07-17

### Added

- **`CONTINUITY_SESSION_ID` override.** A host running several sessions against the
  same git checkout can set this env var per session to give each its own continuity
  identity (presence, handoffs) instead of every session in that checkout collapsing
  into one shared identity. It folds into the `cwd_hash` derivation alongside the git
  toplevel; `repoFullName` is unaffected. Unset (the default) leaves the existing
  one-identity-per-checkout behavior unchanged.
- **Direct messages between sessions** (`message_send` / `message_list` /
  `message_respond` / `message_dismiss`): delivery via prompt-sync injection on the
  recipient's next prompt, with broadcast fan-out to all active sessions and
  timeout-expiring requests (default 10m, configurable with the
  `messageTimeoutMinutes` option). Team-mode note: the Worker routes are a
  follow-up — the tools 404 loudly against a team server until then.
- **Collision negotiation** (new default `collisionGuard: negotiate`). A contested
  edit is now blocked until the other session responds to a
  `message_send(about_file: …)` coordination request or the block expires on its
  own; `warn` keeps the old warn-once behavior, and `off` disables the guard
  entirely. Legacy boolean `collisionGuard` configs map onto the new modes.
  Consent lapses automatically when newer contesting activity arrives on the same
  file, so a stale "go ahead" can never mask a fresh collision.
- **Reply enforcement.** A response-required message denies the next edit once
  (`PreToolUse`) and blocks turn-end (new `Stop` hook, honoring `stop_hook_active`)
  until it's answered, dismissed, or expires — the timeout-override rule means a
  block can never outlive its own deadline.
- **`decision_write requires_ack`** fans out ack-request messages to all active
  sessions.
- **ts↔mjs mirror parity enforced in CI.** New `guard.parity.test.ts` and
  `gate.parity.test.ts` drive both the TypeScript source and the hand-maintained
  plain-ESM mirrors the plugin hooks run (`guard.mjs`, `gate.mjs`) through
  identical inputs and assert deep-equal outputs, so a source change that isn't
  mirrored fails CI immediately instead of silently drifting.

### Fixed

- **`gate.mjs` cwd-hash drift.** The `CONTINUITY_SESSION_ID` salt landed in
  `gate.ts` (the shim) but was missed in its plain-ESM mirror, `gate.mjs` (the
  hooks), for a few commits — whenever the override was set, the shim and hooks
  computed different `cwd_hash` values, so the hooks would read the wrong
  session state file and every gate would silently fail open. Fixed, and now
  covered by `gate.parity.test.ts`.

## [0.1.0-alpha.2] - 2026-07-16

### Added

- **Mid-session coordination deltas.** The `UserPromptSubmit` hook now runs the
  shim's new `--prompt-sync` mode: alongside the existing focus heartbeat, it
  injects what changed since the last prompt — new sessions, other sessions'
  file activity (flagged when same-repo), new decisions, and pending handoffs —
  as `additionalContext`. Announce-once semantics (id sets + a `touched_at`
  high-water mark in the session state file) keep it quiet when nothing changed,
  and a 20s throttle means rapid prompting only pays the heartbeat. Previously
  the SessionStart snapshot was the only inbound signal for the whole session.
- **Collision guard (PreToolUse).** Before a `Write`/`Edit`/`MultiEdit`/
  `NotebookEdit`, a new hook checks the others-activity cache that
  `--snapshot`/`--prompt-sync` maintain in the state file (no network on the hot
  path) and, if another live session touched the same file in the last 30
  minutes, denies the edit once with an instructive reason. Retrying proceeds —
  one deterministic nudge, never a hard wall. Disable with the `collisionGuard`
  plugin option.
- **`--doctor`.** `node <plugin>/mcp/launch.mjs --doctor` prints a diagnostic
  report: Node version, repo gate state (and why it's inert), flavor, backend
  reachability, session state, and duplicate continuity plugin installs. Works
  even when inert — that's when you need it.
- **Duplicate-install warning at SessionStart.** If more than one *enabled*
  `continuity` plugin is installed (e.g. a stale internal build shadowing this
  one), the SessionStart hook surfaces a warning instead of leaving the skills
  to silently collide. Respects `enabledPlugins` across user → project → local
  settings.
- The snapshot now tells the model the coordination tools may be deferred (load
  via ToolSearch) and points at the `continuity:*` skills as the always-visible
  path.
- `task_claim`'s `repo_full_name` is now optional — it defaults to the current
  repo's remote.

### Fixed

- **Old Node no longer fails silently.** A new version-aware launcher
  (`plugin/mcp/launch.mjs`) prints a clear error on Node < 22.5 instead of dying
  on `--experimental-sqlite` with no diagnostics, and the `SessionStart` hook
  injects a visible "plugin inactive" warning into the session. On Node 24+ the
  bundle now runs in-process (no flag, no respawn).
- **File activity can no longer be silently dropped.** The heartbeat flush
  re-reads the session state file and subtracts only the paths it actually
  flushed, so edits recorded by the `PostToolUse` hook during a flush survive.
  All state-file writes are now atomic (tmp + rename), eliminating torn reads
  between the hook and the long-lived shim.
- **Duplicate active decisions are now impossible at the DB level.** Both
  schemas gained a partial unique index (`decisions_active_key_uq`); opening an
  existing local DB (or applying migration `0001`) repairs prior duplicates by
  keeping the newest active row per key. A stale or foreign `supersedes` id now
  returns a loud conflict instead of quietly creating a second active decision —
  closing the select-then-insert race in the team flavor.
- `SIGTERM`/`SIGINT` now actually terminate the MCP server (best-effort checkout,
  then exit, capped at 2s) instead of leaving the process alive.
- The MCP server reports its real package version instead of a hardcoded `0.1.0`.
- File paths are canonicalized (symlinks resolved) before repo-relativization,
  so edits reaching the hook through a symlinked path (e.g. macOS `/tmp`) are
  stored repo-relative instead of absolute.
- The inert server (outside a git repo) now answers `tools/list` with an empty
  list instead of a `-32601 Method not found` JSON-RPC error.

### Added

- **CI** (GitHub Actions): typecheck + tests on Node 22 and 24, plus a
  bundle-sync job that fails if the committed plugin payload drifts from source.
- The local-backend test suite now runs on Node 22.x (vitest workers get
  `--experimental-sqlite`), and new tests cover the decision-conflict
  guarantees.

### Changed

- The plugin's `apiKey` config is marked `sensitive` — stored in the system
  keychain instead of plaintext `settings.json`.
- Documented Node floor corrected to **≥ 22.5** (`node:sqlite` shipped in 22.5).
- The per-prompt focus-sync hook's shim timeout was reduced to stay under the
  hook's own budget.
- `docs/examples/arlo.md` renamed to `docs/examples/repo-allowlist.md`.

## [0.1.0-alpha.1] — Alpha

Initial public alpha: the first open-source release of Continuity, coordination for
parallel Claude Code sessions, shipping **two flavors from one codebase**.

### Added

- **Two flavors, one codebase.**
  - **Local** — zero-config, single machine. Multiple Claude Code sessions
    coordinate through a shared SQLite file at `~/.continuity/continuity.db`. No
    server, no auth, lazy expiry on read.
  - **Team** — multi-machine. A Cloudflare Worker over Neon Postgres with
    per-teammate API keys (stored HMAC-hashed) and a janitor cron for expiry.
  - The Claude Code plugin auto-selects the flavor: `apiUrl` + `apiKey` → team,
    otherwise local.
- **Coordination core (17 MCP tools)** available in both flavors:
  - Presence — `agent_list_active`, `agent_get`, `agent_report_focus`,
    `agent_file_activity_recent`, plus check-in/heartbeat/checkout and audit.
  - Decisions — `decision_write`, `decision_recent`, `decision_get_by_key`,
    `decision_supersede` (duplicate keys return a typed conflict, never a silent
    overwrite).
  - Task claims — `task_claim`, `task_update`, `task_release`, `task_complete`,
    `task_list` (atomic claims; a contended issue returns a conflict).
  - Handoffs — `handoff_create`, `handoff_pending`, `handoff_accept`,
    `handoff_complete`.
  - An append-only audit log.
- **Team-only tools (8)** layered on the team server: `github_*`, `plan_*`, and
  `escalate` (GitHub Projects integration, plan-check, Slack escalation).
- **The `ContinuityBackend` seam** — a single interface with two implementations
  (`LocalBackend` over SQLite, `RemoteBackend` over HTTP), so both flavors share
  identical query logic and wire format.
- **Claude Code plugin with 9 hooks:**
  - `SessionStart` — injects a coordination snapshot into context.
  - `SessionEnd` — checks the session out.
  - `UserPromptSubmit` — syncs the session's current focus from the prompt.
  - `CwdChanged` and `WorktreeCreate` — re-check-in for the new working tree.
  - `WorktreeRemove` — checkout.
  - `TaskCreated` / `TaskCompleted` — audit events.
  - `PostToolUse` — records file activity for edited paths.
- **Repo gate** — activates in any git repo by default; scope with `repoAllowlist`.
  Inert outside git repositories.
- Documentation: architecture, local-mode, and team-mode guides.

### Known limitations

- This is an **alpha**: APIs and storage are unstable and may change without notice.
- The team server has **no rate limiting** yet.
- Requires **Node ≥ 22** (the local flavor uses Node's built-in `node:sqlite`; the
  launcher passes `--experimental-sqlite` on Node 22.x–23.x).
- The team flavor has not been validated against a live Cloudflare/Neon deployment.
- Non-standard hook event names and the `UserPromptSubmit` payload are carried over
  from an internal deployment and should be verified against the live Claude Code
  harness (see `docs/validation-checklist.md`).

[Unreleased]: https://github.com/uziiuzair/continuity-mcp/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/uziiuzair/continuity-mcp/releases/tag/v0.1.0-alpha.1

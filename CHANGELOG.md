# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> ⚠️ **Alpha.** Continuity is pre-1.0 and unstable. The schema, tool surface, wire
> format, and plugin may change without notice between alpha releases, including
> breaking changes that are not reflected in a major version bump.

## [Unreleased]

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

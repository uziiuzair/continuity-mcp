# Architecture

Continuity coordinates **parallel Claude Code sessions** — presence, file-activity
awareness, typed decisions, atomic task claims, handoffs, and an audit log. It ships
**two flavors from one codebase**, and the plugin picks the flavor automatically.

This document describes the system design: the two flavors, the seam that makes them
interchangeable, the shared package, how local and team differ, the plugin, and the
data model.

## Two flavors

| | **Local** | **Team** |
|---|---|---|
| Storage | SQLite at `~/.continuity/continuity.db` | Neon Postgres |
| Transport | in-process (`node:sqlite`) | Cloudflare Worker (HTTPS + API key) |
| Scope | one machine, many sessions | many machines, many teammates |
| Auth | none (single implicit user) | per-teammate API key (HMAC-hashed) |
| Expiry | lazy, on read | janitor cron (every minute) |
| Extras | coordination core only | + GitHub / plan-check / Slack |
| Setup | zero config | deploy a Worker + Neon |
| Node | ≥ 22 (`node:sqlite`) | ≥ 22 (wrangler 4) |

```
  LOCAL flavor (single machine)              TEAM flavor (many machines)

  ┌──────────────┐  ┌──────────────┐         ┌──────────────┐   ┌──────────────┐
  │ Claude Code  │  │ Claude Code  │         │ Claude Code  │   │ Claude Code  │
  │  session A   │  │  session B   │         │ (teammate 1) │   │ (teammate 2) │
  └──────┬───────┘  └──────┬───────┘         └──────┬───────┘   └──────┬───────┘
         │ shim            │ shim                   │ shim             │ shim
   ┌─────▼─────┐     ┌─────▼─────┐            ┌─────▼─────┐      ┌─────▼─────┐
   │LocalBackend│    │LocalBackend│           │RemoteBack. │     │RemoteBack. │
   └─────┬─────┘     └─────┬─────┘            └─────┬─────┘      └─────┬─────┘
         │    node:sqlite   │                       │  HTTPS + API key │
         └────────┬─────────┘                       └────────┬─────────┘
                  ▼                                          ▼
        ~/.continuity/continuity.db                ┌──────────────────┐
        (WAL, shared file)                          │ Cloudflare Worker│
                                                    │  (Hono + Drizzle)│
                                                    └────────┬─────────┘
                                                             ▼
                                                       Neon Postgres
                                                     (+ janitor cron)
```

## The seam: `ContinuityBackend`

Every coordination tool calls a method on a single interface — `ContinuityBackend`
(`packages/shared/src/backend.ts`) — and nothing else. Two implementations satisfy it:

- **`LocalBackend`** (`packages/mcp/src/backends/local.ts`) — raw `node:sqlite`
  prepared statements (no native deps), aliasing columns to the shared mappers,
  injecting a fabricated single-user identity, and running the lazy-expiry sweep.
- **`RemoteBackend`** (`packages/mcp/src/backends/remote.ts`) — HTTPS to the Cloudflare
  Worker, which exposes the same method surface over the wire.

The interface has 22 methods (the 17 model-facing MCP tools plus lifecycle methods
the shim/hooks drive directly — `checkin`, `heartbeat`, `checkout`, `fileActivity`,
`auditEvent`), grouped as presence
(`checkin`, `heartbeat`, `checkout`, `listActive`, `getSession`, `fileActivity`,
`recentFileActivity`, `auditEvent`), decisions (`decisionWrite`, `decisionRecent`,
`decisionGetByKey`, `decisionSupersede`), task claims (`taskClaim`, `taskUpdate`,
`taskRelease`, `taskComplete`, `taskList`), handoffs (`handoffCreate`, `handoffPending`,
`handoffAccept`, `handoffComplete`), and audit (`auditRecent`).

**Conflicts are typed, not silent.** Writes that can lose a uniqueness race —
`decisionWrite` (duplicate decision key) and `taskClaim` (issue already claimed) — return
a `ConflictResult<T>` rather than overwriting or throwing:

```ts
type ConflictResult<T> = { conflict: true; existing: T } | { conflict: false; result: T }
```

Both backends represent the conflict identically, so the model always sees the
conflicting row and can react instead of clobbering it. Other failures (not_found,
validation) reject the promise. All timestamps in returned DTOs are ISO-8601 strings.

## The shared package (`@continuity/shared`)

`packages/shared/src/` holds everything that must be identical across flavors, kept
**dialect-free** at the call site:

- **`schema.pg.ts`** — Postgres tables (`pgTable`) for the team flavor, including a
  `users` table and a `project_state_cache` table.
- **`schema.sqlite.ts`** — the SQLite mirror (`sqliteTable`): `uuid`→`text`,
  `timestamptz`→ISO-8601 `text`, enums→`text` + `CHECK`. No `users` table (single
  implicit user, user FKs dropped) and no `project_state_cache` (team-only). Tables are
  created at runtime from an idempotent `SQLITE_DDL` string — no migration step, so
  local mode is genuinely zero-config.
- **`types.ts`** — wire DTOs shared by both backends and the Worker.
- **`backend.ts`** — the `ContinuityBackend` interface (the seam) and its arg types.
- **`mappers.ts`** — row → DTO serializers (fill `user_name` for local, where there is
  no join).
- **`time.ts`** — `toIso()` / `now()`, dialect-neutral. ISO text stores
  lexicographically, so string comparison equals chronological order.
- **`status.ts`** — `derivedStatus()` (active / idle / gone from age) and related logic.
- **`schema-parity.checks.ts`** — a compile-time check that both schema files export the
  same identifiers, so the two dialects can't drift apart.

The business logic lives in dialect-agnostic query functions; one function body serves
both dialects because the Drizzle query builder is dialect-agnostic at the call site.

## Local: SQLite + lazy expiry

There is no background process locally, so there is no cron to expire stale state.
Instead expiry happens **lazily, on read**, plus an opportunistic sweep:

- `derivedStatus()` computes active / idle / gone from `last_seen_at` at read time
  (5-minute / 30-minute thresholds), so a crashed session reads as gone without anyone
  marking it.
- A `sweep()` (sessions → gone, expired claims → released, file activity older than 24h
  pruned) is called opportunistically on `checkin` / `heartbeat`, throttled to roughly
  once a minute.

Parallel sessions on one machine coordinate safely because `openLocalDb`
(`packages/mcp/src/backends/db.ts`) opens the file with WAL pragmas
(`journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`). Atomic claims use a partial
`UNIQUE` index plus `INSERT ... ON CONFLICT DO NOTHING`, so exactly one of two racing
processes wins a claim on the same issue.

## Team: Worker + Neon + janitor cron

The team flavor is a Cloudflare Worker (`packages/server`, Hono + Drizzle over the Neon
serverless driver). It authenticates every request with a per-teammate API key (the
server stores only an HMAC hash) and exposes the same method surface over HTTP routes.

Because the Worker runs continuously, it uses a **janitor cron** instead of lazy expiry:
`wrangler.toml` registers `crons = ["* * * * *"]` (every minute) to expire idle/gone
sessions, prune file activity, and auto-release stale claims. Atomic claims rely on the
same partial-unique-index + `ON CONFLICT` approach as local.

GitHub Projects integration, plan-check, and Slack escalation are **team-only**
extras: they live on a separate `TeamBackend` interface (not the `ContinuityBackend`
core), are served by dedicated Worker routes, and surface as the `github_*`, `plan_*`,
and `escalate` tools — registered only in remote mode. Each degrades gracefully when its
secret is absent, so the Worker deploys with just `DATABASE_URL` + `API_KEY_HMAC_SECRET`.
The coordination core is identical across both flavors.

## The plugin

The Claude Code plugin (`plugin/`, name `continuity`) is what selects the flavor and
drives presence. It launches the bundled shim via `.mcp.json` and reads four optional
`userConfig` values: `apiUrl`, `apiKey`, `repoAllowlist`, `dbPath`.

**Backend selection** (`packages/mcp/src/index.ts`):

```
repo = resolveRepoContext(cwd, allowlist)   # empty allowlist → any git repo
if (!repo) → run inert (complete the MCP handshake, register nothing)
if (apiUrl && apiKey) → RemoteBackend, mode = "remote"
else                  → LocalBackend(openLocalDb(CONTINUITY_DB_PATH ?? ~/.continuity/continuity.db)), mode = "local"
register the coordination core tools; team-only tools attach only when mode = "remote"
start a 45s heartbeat, a 20s pending-file flush, and a SIGTERM/SIGINT checkout
```

**Hooks** (`plugin/hooks/hooks.json`) — every hook fails open; a non-git repo or an
unreachable backend never blocks the session:

- **`SessionStart`** runs `scripts/session-start.mjs`, which shells out to the bundled
  shim's read-only `--snapshot` subcommand. The shim checks in and prints the
  coordination snapshot (who's active, recent file activity, recent decisions, pending
  handoffs) for whichever flavor is configured. Keeping the backend logic in the shim
  lets the hook stay zero-dependency.
- **`PostToolUse`** (matching `Write|Edit|MultiEdit|NotebookEdit`) runs
  `scripts/post-tool-use.mjs`, which appends the touched path (deduped) to a per-repo
  **rendezvous state file** — it needs no network or DB access. The long-lived shim then
  **flushes** that buffer to whichever backend on its heartbeat (after a ~20s stale
  threshold so a trailing edit isn't lost). This split works identically in both flavors.

The **repo gate** (`packages/mcp/src/gate.ts`) keeps the user-wide plugin inert outside
the repos you care about. An empty allowlist activates in **any git repo**; a set
allowlist activates only in repos whose normalized git remote (`host/owner/repo`) matches
an entry. A non-git directory is always inert.

## Data model

Both schemas share the same tables (the SQLite mirror drops `users` and
`project_state_cache`):

| Table | Purpose | Notable columns / guarantees |
|---|---|---|
| `agent_sessions` | presence / heartbeats | `status` active/idle/gone; partial unique index → at most one live session per `cwd_hash` |
| `file_activity` | which files sessions touched | `tool` ∈ Write/Edit/MultiEdit/NotebookEdit; unique per (session, path); pruned after 24h |
| `decisions` | typed shared decisions | `decision_type` ∈ architecture/tooling/process/scope/other; `status` active/pending/superseded/rejected; `supersedes` link |
| `task_claims` | atomic issue claims | `status` ∈ claimed/in_progress/pr_open/released/completed; partial unique index → at most one live claim per (repo, issue) |
| `handoffs` | structured context transfers | `status` ∈ pending/accepted/completed/expired |
| `audit_events` | append-only event log | `event_type`, optional `payload` |
| `users` | *team only* | email, name, HMAC-hashed API key, optional `github_username` |
| `project_state_cache` | *team only* | cached GitHub Projects board state (for the `github_*` tools) |

The partial unique indexes (`agent_sessions_cwd_live_uq`, `task_claims_live_uq`) are what
make checkin convergence and claim races atomic — they power the `ON CONFLICT` writes in
both dialects.

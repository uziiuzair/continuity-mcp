# Continuity — Open-Source Implementation Plan

> ⚠️ **Historical.** This is the original plan and reflects early decisions that have
> since changed. Most notably: the local backend no longer uses `better-sqlite3` + Drizzle
> with a committed native addon — it now uses Node's built-in **`node:sqlite`** (raw SQL,
> no native deps, pure-JS bundle, **Node ≥ 22**). For current behavior see the README and
> `docs/`. References below to `better-sqlite3`, Drizzle in the local path, native bundling,
> or Node 20 are superseded.

## Context

Continuity is a coordination layer for **parallel Claude Code sessions**: shared
presence/heartbeats, file-activity awareness, typed decisions (with supersede),
atomic task claims, structured handoffs, and an audit log. It currently exists as
a closed-source plugin bespoke to the "Arlo" team, backed by a Cloudflare Worker +
Neon Postgres.

This repo open-sources it for the general public in **two flavors from one codebase**:

1. **Local** — single machine, multiple parallel Claude Code sessions coordinate
   through a shared **SQLite** file. Zero config, no server, no auth. Coordination
   core only.
2. **Team** — the Arlo-style deployment: **Cloudflare Worker + Neon Postgres**,
   per-teammate API keys, plus GitHub Projects / plan-check / Slack escalation.

The architecture is feasible because the existing MCP tools already isolate all I/O
behind a single seam — every tool calls `ctx.client.<method>`. We turn that into a
`ContinuityBackend` interface with two implementations.

> Source material adapted from `~/ooozzy/arlo-internal`:
> `packages/continuity-mcp/` (shim), `workers/continuity-api/` (Worker + route
> logic), `db/src/schema.ts` (PG schema), `plugins/continuity/` (plugin wrapper),
> `docs/continuity-mcp.md` (design doc).
> SQLite + WAL + native-bundling **reference pattern only**: `~/ooozzy/continuity/server/`.

## Confirmed decisions

- Full monorepo, both flavors.
- Two flavors via a `ContinuityBackend` interface (remote HTTP / local SQLite).
- Local flavor = coordination **core only** (no GitHub/plan/Slack/digest).
- No cron locally → **lazy expiry on read** + opportunistic sweep on checkin/heartbeat.
- Generic + sensible defaults: zero-config local works in **any git repo**, single
  implicit user. Arlo specifics become an example config only.
- Scoped npm: `@continuity/mcp`, `@continuity/server`, `@continuity/shared`. Plugin
  name stays `continuity`. MIT license.

## Directory tree

```
continuity-mcp/
├── package.json                 root: pnpm -r scripts
├── pnpm-workspace.yaml          packages/*, plugin
├── tsconfig.base.json
├── LICENSE                      MIT
├── README.md                    two install paths + config table
├── IMPLEMENTATION_PLAN.md       (this file)
├── packages/
│   ├── shared/                  @continuity/shared
│   │   └── src/
│   │       ├── schema.pg.ts          (from arlo db/src/schema.ts)
│   │       ├── schema.sqlite.ts      (new; sqliteTable mirror)
│   │       ├── types.ts              wire DTOs
│   │       ├── backend.ts            ContinuityBackend interface (the seam)
│   │       ├── time.ts               toIso()/now() dialect-neutral
│   │       └── queries/              dialect-agnostic business logic
│   │           ├── agent.ts decisions.ts tasks.ts handoffs.ts audit.ts expiry.ts
│   ├── mcp/                     @continuity/mcp (the shim + plugin payload)
│   │   ├── build.mjs                 esbuild; better-sqlite3 external
│   │   ├── bin/cli.mjs               npx entry
│   │   └── src/
│   │       ├── index.ts              bootstrap + backend selection + heartbeat
│   │       ├── gate.ts state.ts
│   │       ├── backends/{remote,local,db}.ts
│   │       └── tools/{util,agent,decisions,tasks,handoffs,github,plan}.ts
│   └── server/                  @continuity/server (Cloudflare Worker, team flavor)
│       ├── wrangler.toml .dev.vars.example drizzle.config.ts
│       ├── scripts/create-user.ts
│       └── src/{index,auth,identity,types,events,scheduled,janitor}.ts + routes/
├── plugin/                      Claude Code plugin (name "continuity")
│   ├── .claude-plugin/plugin.json   apiUrl/apiKey OPTIONAL
│   ├── .mcp.json                    launches bundled shim, no required env
│   ├── mcp/index.mjs                committed esbuild bundle (+ native node_modules)
│   ├── hooks/ scripts/ skills/      de-Arlo-ified
└── docs/
    ├── architecture.md local-mode.md team-mode.md examples/arlo.md
```

## The seam: `ContinuityBackend` (`packages/shared/src/backend.ts`)

Mirrors exactly the method surface `ContinuityClient` exposes today. The 409-conflict
case becomes a typed discriminated union so both backends represent it identically:

```ts
export type ConflictResult<T> = { conflict: true; existing: T } | { conflict: false; result: T }
```

Methods: `checkin, heartbeat, checkout, listActive, getSession, fileActivity,
recentFileActivity, auditEvent` (presence) · `decisionWrite→ConflictResult, decisionRecent,
decisionGetByKey, decisionSupersede` · `taskClaim→ConflictResult, taskUpdate, taskRelease,
taskComplete, taskList` · `handoffCreate, handoffPending, handoffAccept, handoffComplete` ·
`auditRecent`.

- **RemoteBackend** = today's `ContinuityClient` verbatim (arlo `client.ts`); only the
  409 branch is typed into `ConflictResult`.
- **LocalBackend** wraps a better-sqlite3 Drizzle instance, delegates to
  `packages/shared/queries/*`, injects a fabricated local identity, runs lazy-expiry sweep.
- GitHub/plan/escalate are **not** on the core interface — Worker-only client extension,
  tools registered only when `mode === "remote"`.

`ToolContext` becomes `{ backend, getSessionId, repoFullName, mode }`; tools change
`ctx.client` → `ctx.backend`.

## Shared schema + query strategy

**Two schema files, one set of query functions.** Drizzle's `pgTable`/`sqliteTable`
differ, but the query *builder* is dialect-agnostic at the call site. Each
`queries/*.ts` function takes `(db, schema, identity, args)` so one body serves both.

Divergence points (small, isolated):
1. **IDs** — generate `crypto.randomUUID()` in JS for both (PG default harmless).
2. **Timestamps** — PG `timestamptz`→`Date`; SQLite ISO-8601 `text`. `time.ts/toIso()`
   normalizes; store ISO text for lexicographic comparability.
3. **Atomic claim** — both support partial unique index + `ON CONFLICT DO NOTHING`.
   WAL + `busy_timeout` makes cross-process claims race-safe.
4. **`xmax=0` insert/update detection** (arlo `routes/agent.ts`) is PG-only → SQLite
   checkin does SELECT-then-write in a transaction.
5. **Supersede / upsert transitions** — two statements in a tx; `withTx(db, fn)` adapter.

## Local SQLite schema (`schema.sqlite.ts`)

PG mirror: `uuid`→`text`, `timestamptz`→`text` (ISO), enums→`text` + CHECK. **No `users`
table** (single implicit user; user FKs dropped). Drop `project_state_cache` (team only).
Keep partial unique indexes for live sessions and live claims. DDL via idempotent
`CREATE TABLE IF NOT EXISTS` run on db open (no migration step → zero-config).

**Lazy expiry** (`queries/expiry.ts`) replaces the Worker janitor: `derivedStatus()`
computes active/idle/gone on read (5m/30m); `sweep()` (sessions→gone, expired claims→
released, prune file_activity >24h) called opportunistically on checkin/heartbeat,
throttled ~60s.

## Backend selection (`packages/mcp/src/index.ts`)

```
repo = resolveRepoContext(cwd, allowlist)        // empty allowlist → any git repo
if (!repo) connect inert; return
if (apiUrl && apiKey) backend = RemoteBackend(...), mode="remote"
else backend = LocalBackend(openLocalDb(CONTINUITY_DB_PATH ?? ~/.continuity/continuity.db)), mode="local"
register core tools always; github+plan only if mode==="remote"
start 45s heartbeat + 20s pending-file flush + SIGTERM/SIGINT checkout   (reused verbatim)
```

`openLocalDb` reuses WAL pragmas (`journal_mode=WAL`, `busy_timeout=5000`,
`foreign_keys=ON`) — what makes parallel shim processes safe on one DB file.

## Build & packaging

- **shared** — plain `tsc` (or source via workspace `exports`).
- **mcp** — esbuild bundle (ESM, node20, `createRequire` banner for the CJS SDK).
  `better-sqlite3` stays **external** (native) + a real dependency. `bin/cli.mjs` uses
  `createRequire` so the addon resolves under npx. Build emits `plugin/mcp/index.mjs`
  + copies native deps into `plugin/mcp/node_modules/` (the `--with-native` trick).
  Caveat: committed prebuild matches build-machine arch; document `npm i` fallback.
- **server** — wrangler-deployed (wrangler bundles); drizzle migrations for Neon.

## Plugin wrapper changes

- `plugin.json`: de-Arlo-ified description; `apiUrl`/`apiKey` **optional** (absent →
  local); `repoAllowlist` "blank → any git repo".
- `.mcp.json`: same launch; empty env → local mode; optional `CONTINUITY_DB_PATH`.
- `gate.mjs`/`gate.ts`: default allowlist **empty/any** (keep cwdHash + remote
  normalization).
- Hooks: keep fail-open. Writes stay remote-only; local presence/activity is driven by
  the shim. SessionStart snapshot in local mode via a read-only `--snapshot` subcommand
  on the bundled shim (preserves zero-dependency hooks).
- Skills: reword "on Arlo" → "in this repo"/"your team"; `claim-issue` notes it's
  team-flavor (local uses `task_claim`).

## Identity

- **Team**: unchanged — `users` + HMAC-hashed API key + `github_username`.
- **Local**: no users table, no auth. `LocalBackend` builds constant identity
  `{ userId:"local", userName: os.userInfo().username, githubUsername:null }` and injects
  it; serializers fill `user_name` since there's no join.

## Phases (build order + verification)

- **P0 — Skeleton.** Root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
  LICENSE, `.gitignore`, README stub. ✔ `pnpm install`; `pnpm -r typecheck`.
- **P1 — shared: schema + types + interface.** ✔ `tsc`; both schemas export identical
  identifiers.
- **P2 — shared/queries + expiry + withTx.** ✔ unit tests on `:memory:` db: checkin
  idempotency, atomic-claim race, decision conflict+supersede, idle/gone, auto-release.
- **P3 — mcp: LocalBackend + tools + selection.** ✔ stdio run with `CONTINUITY_DB_PATH`;
  two processes claim same issue → exactly one wins.
- **P4 — mcp build + plugin payload.** ✔ `node plugin/mcp/index.mjs` in a throwaway git
  repo → local mode, creates DB; npx resolves native addon.
- **P5 — server (team flavor).** ✔ `wrangler dev` + `.dev.vars` against a Neon branch;
  `/agent/checkin`, `/tasks/claim` conflict; RemoteBackend tools end-to-end.
- **P6 — plugin wrapper + skills + de-Arlo-ification.** ✔ install in two repos (no config
  → local; apiUrl/apiKey → remote); snapshot renders in both; inert in non-git dir.
- **P7 — docs + README + names + license.** ✔ `pnpm -r build && typecheck` clean;
  `npm pack --dry-run`; fresh clone reproduces `plugin/mcp/index.mjs`.

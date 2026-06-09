# Team mode

Team mode is the multi-machine flavor: a **Cloudflare Worker** over **Neon Postgres**,
with a per-teammate API key. Many teammates, each on their own machine, share one
coordination backend.

The plugin runs in team mode when you give it an `apiUrl` and `apiKey`; otherwise it runs
[locally](./local-mode.md).

## Prerequisites

- **Node ≥ 22.** The server uses **wrangler 4**, which requires Node.js ≥ 22. (Both
  flavors require Node ≥ 22 — the local flavor uses `node:sqlite`.)
- **pnpm 9** and a clone of this repo (`pnpm install` at the root).
- A **Cloudflare account** with `wrangler` authenticated.
- A **Neon Postgres** project. Use the **pooled** connection string (the host contains
  `-pooler`).

## Deploy the server

All commands run from `packages/server` (or with `pnpm --filter @continuity/server`).

### 1. Set secrets

The Worker needs two secrets:

- `DATABASE_URL` — your Neon **pooled** connection string.
- `API_KEY_HMAC_SECRET` — a high-entropy random string used to hash API keys. Keep it
  stable: changing it invalidates every issued key. Generate one with
  `openssl rand -hex 32`.

For local development (`wrangler dev`), copy `.dev.vars.example` to `.dev.vars` and fill
both in. For production, set them as secrets:

```bash
wrangler secret put DATABASE_URL
wrangler secret put API_KEY_HMAC_SECRET
```

### 2. Run migrations

Generate and apply the Postgres schema to your Neon database with Drizzle:

```bash
pnpm --filter @continuity/server db:generate   # drizzle-kit generate
pnpm --filter @continuity/server db:push       # drizzle-kit push
```

### 3. Deploy

```bash
pnpm --filter @continuity/server deploy         # wrangler deploy
```

Note the Worker's URL — that's the `apiUrl` your teammates will configure.

The Worker registers a **janitor cron** (`crons = ["* * * * *"]` in `wrangler.toml`) that
runs every minute to expire idle/gone sessions, prune old file activity, and auto-release
stale claims. (Local mode has no cron and does this lazily on read instead.)

## Create users

Each teammate needs their own API key. The `user:create` script generates a 256-bit key,
stores only its HMAC hash, and prints the raw key **once** — it's never recoverable
afterward.

```bash
DATABASE_URL=... API_KEY_HMAC_SECRET=... \
  pnpm --filter @continuity/server user:create <email> <name> [github_username]
```

`github_username` is optional. Run this once per teammate and hand each person their key.

## Configure the plugin

Each teammate installs the `continuity` plugin and sets two config values:

- **`apiUrl`** — the deployed Worker's URL.
- **`apiKey`** — the key you issued them with `user:create`.

With both present, the plugin selects **team** mode automatically and all coordination
flows through the Worker. (Leaving them blank falls back to local mode.) The optional
`repoAllowlist` config scopes Continuity to specific repos — see
[`examples/repo-allowlist.md`](./examples/repo-allowlist.md).

## Team-only extras

On top of the shared coordination core, team mode adds three **team-only** capabilities,
each surfaced as MCP tools registered only in remote mode and each degrading gracefully
when its secret is absent:

- **GitHub Projects** (`github_*`) — list/claim issues, open PRs, update status. Needs the
  `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_INSTALLATION_ID` secrets.
- **Plan-check** (`plan_*`) — Claude Haiku phase-gating. Needs `ANTHROPIC_API_KEY`
  (without it, `plan_check` returns permissive so it never blocks).
- **Slack escalation** (`escalate`) — posts to `SLACK_WEBHOOK_URL` if set, else records an
  audit event only.

A weekly digest cron and a GitHub-assignee reconciliation cron round these out. The
coordination core (presence, file activity, decisions, task claims, handoffs, audit) is
identical across both flavors; team mode adds the shared server, per-teammate auth, and
multi-machine reach.

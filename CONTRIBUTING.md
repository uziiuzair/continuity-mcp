# Contributing to Continuity

Thanks for your interest in Continuity — coordination for parallel Claude Code
sessions. This is an **early alpha** (`0.1.0-alpha.1`); the schema, tool surface,
and plugin are all unstable. Contributions, bug reports, and validation against the
live Claude Code harness are especially welcome.

## Prerequisites

- **Node ≥ 22** and **pnpm 9**.
  - The local flavor uses Node's built-in `node:sqlite`, which is available behind
    `--experimental-sqlite` on Node 22.x–23.x and unflagged on Node 24+.
  - The team flavor's tooling (Wrangler 4) also requires Node ≥ 22.
  - In short: develop on **Node 22 or newer**. Node 20 is not supported.

## Setup

```bash
pnpm install
```

This installs all workspace dependencies. From there:

```bash
pnpm -r typecheck                       # typecheck every package
pnpm -r test                            # run the test suite across packages
pnpm --filter @continuity/mcp build     # build the MCP shim + plugin payload
```

## Workspace layout

Continuity is a pnpm-workspaces monorepo (`packages/*` + `plugin/`):

```
packages/shared   @continuity/shared  — schema, wire types, the ContinuityBackend
                                         interface, dialect-agnostic query logic,
                                         row→DTO mappers, time/status helpers
packages/mcp      @continuity/mcp     — the MCP server (LocalBackend + RemoteBackend),
                                         backend selection, the repo gate, and the
                                         committed plugin payload
packages/server   @continuity/server  — the Cloudflare Worker (team flavor) over Neon
plugin/           the Claude Code plugin (hooks, skills, .mcp.json, bundled shim)
docs/             architecture, local-mode, team-mode, examples
```

### Source-first monorepo

Packages reference each other by their workspace `exports` and are consumed
**from source** during development — you generally do not need to pre-build
`@continuity/shared` to typecheck or test `@continuity/mcp`. Just run
`pnpm -r typecheck` / `pnpm -r test` and let the workspace resolve.

The one place a build is required is the committed plugin payload (below).

## Building the plugin payload

The Claude Code plugin ships a **single committed esbuild bundle** at
`plugin/mcp/index.mjs`. Regenerate it with:

```bash
pnpm --filter @continuity/mcp build
```

This runs esbuild (ESM, Node target) to produce one **pure-JS** file. The local
backend uses Node's built-in `node:sqlite`, so there is **no native dependency**
and **no `node_modules`** in the payload — it's cross-platform as-is. Notes:

- Requires **Node ≥ 22** (`node:sqlite`); the launcher passes `--experimental-sqlite`
  on Node 22.x–23.x (a no-op on 24+).
- A fresh clone should reproduce `plugin/mcp/index.mjs` deterministically — if your
  change affects the shim, **rebuild and commit the regenerated payload** so the
  plugin stays in sync with the source.

## Coding conventions

- **TypeScript strict.** All packages compile under strict mode; keep them clean
  (`pnpm -r typecheck` must pass before you open a PR).
- **The `ContinuityBackend` seam.** Every coordination tool talks to a single
  interface (`packages/shared/src/backend.ts`) — `ctx.backend.<method>` — and
  nothing else. Both `LocalBackend` (SQLite) and `RemoteBackend` (HTTP to the
  Worker) must satisfy the same surface. Do not let a tool reach around the seam to
  a specific backend; if you need new behavior, add it to the interface and
  implement it in both backends.
- **Wire-format parity via shared mappers.** Both backends and the Worker must emit
  identical DTOs. Go through the shared serializers (`packages/shared/src/mappers.ts`)
  so local and team produce the same JSON shape — including ISO-8601 timestamps and
  the typed `ConflictResult<T>` for races (duplicate decision key, already-claimed
  issue). Conflicts are returned, never silently overwritten.
- **Dialect-agnostic queries.** Business logic lives in the shared query functions
  so one body serves both the Postgres and SQLite dialects. Keep dialect-specific
  divergence isolated (IDs, timestamps, transaction adapters).
- **Schema parity.** `schema.pg.ts` and `schema.sqlite.ts` must export the same
  identifiers (enforced by a compile-time parity check). Add columns/tables to both
  where they apply (remembering `users` and `project_state_cache` are team-only).

## Running the tests

```bash
pnpm -r test                              # everything
pnpm --filter @continuity/shared test     # a single package
```

The query/expiry logic is unit-tested against an in-memory SQLite database
(checkin idempotency, atomic-claim races, decision conflict + supersede,
idle/gone derivation, auto-release). **Automated tests cannot exercise the live
Claude Code plugin harness** (hooks, the MCP handshake, the SessionStart
snapshot) — for that, run through [`docs/validation-checklist.md`](./docs/validation-checklist.md)
in a real session before releasing.

## Pull requests

- Branch off the default branch; keep changes focused.
- Run `pnpm -r typecheck` and `pnpm -r test` before pushing.
- If you touched the shim, rebuild and commit `plugin/mcp/`.
- Describe what you changed and how you verified it (include manual validation
  steps if you tested the plugin live).

## Reporting bugs and requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For anything
security-sensitive, see [`SECURITY.md`](./SECURITY.md) — do **not** open a public
issue for vulnerabilities.

# Continuity

> ⚠️ **Alpha.** This is an early alpha release (`0.1.0-alpha.1`). Everything here —
> the local and team flavors, the schema, the plugin, and the tool surface — is
> unstable and may change without notice. Expect rough edges and breaking changes;
> not yet recommended for production-critical workflows.

Coordination for **parallel Claude Code sessions**. When you run more than one
Claude Code agent at once — across worktrees, terminals, or teammates — Continuity
gives every session a shared view of:

- **Presence** — who else is working right now and what they're focused on
- **File activity** — which files other sessions have touched recently (so you don't collide)
- **Decisions** — typed, append-only shared decisions with explicit supersede semantics
- **Task claims** — atomic "I've got this issue" claims so two agents don't duplicate work
- **Handoffs** — structured context transfers between agents (or to a human)
- **Audit log** — an append-only record of every coordination event

Conflicts are **loud, not silent**: when two agents disagree (same decision key, same
issue), the API returns a conflict instead of overwriting.

## Two flavors, one codebase

| | **Local** | **Team** |
|---|---|---|
| Storage | SQLite file on your machine | Neon Postgres |
| Transport | in-process | Cloudflare Worker (HTTPS + API key) |
| Scope | one machine, many sessions | many machines, many teammates |
| Auth | none (single implicit user) | per-teammate API key |
| Extras | coordination core only | + GitHub Projects, plan-check, Slack escalation |
| Setup | zero config | deploy a Worker + Neon |

The Claude Code plugin picks the flavor automatically: if you provide an API URL and
key it runs in **team** mode; otherwise it runs **local** against
`~/.continuity/continuity.db`.

## Install

In Claude Code, add this repo as a plugin marketplace and install the plugin:

```
/plugin marketplace add uziiuzair/continuity-mcp   # or a local path to this repo
/plugin install continuity@continuity
```

With no configuration it runs in **local** mode (SQLite, zero-config). For
**team** mode, set the plugin's `apiUrl` + `apiKey` to your deployed Worker —
Claude Code prompts for these when you enable the plugin, and you can change
them later via `/plugin` → continuity → Configure. The API key is stored in
your system keychain, not in `settings.json`.

> **Requires Node ≥ 22.5.** The local flavor uses Node's built-in `node:sqlite`
> (no native dependencies — the plugin bundle is pure JS and cross-platform),
> which shipped in Node 22.5. The launcher adds `--experimental-sqlite` on Node
> 22.x–23.x (unflagged on 24+) and prints a clear error on older Nodes instead
> of failing silently.

> **Permission rules:** in `allowedTools` / `--allowedTools` / hook matchers, the
> plugin's tools are namespaced as `mcp__plugin_continuity_continuity__<tool>`
> (e.g. `mcp__plugin_continuity_continuity__decision_write`), not bare tool names.

## Documentation

- [Architecture](./docs/architecture.md) — the two flavors, the `ContinuityBackend` seam, the data model
- [Local mode](./docs/local-mode.md) — zero-config single-machine setup
- [Team mode](./docs/team-mode.md) — deploying the Cloudflare Worker + Neon
- [Example team setup](./docs/examples/repo-allowlist.md) — scoping Continuity to specific repos

## Status

🚧 Early development. See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the
architecture and build phases.

**Node version:** **Node ≥ 22.5** for both flavors — the local flavor uses
`node:sqlite` (Node 22.5+), and the team flavor's Wrangler 4 tooling also needs Node 22+.

## Repo layout

```
packages/shared   @continuity/shared  — schema, types, the ContinuityBackend interface, query logic
packages/mcp      @continuity/mcp     — the MCP server (local + remote backends) and plugin payload
packages/server   @continuity/server  — the Cloudflare Worker (team flavor)
plugin/           the Claude Code plugin (hooks, skills, .mcp.json)
docs/             architecture, local-mode, team-mode, examples
```

## Development

```bash
pnpm install
pnpm -r typecheck
pnpm -r build
```

Requires Node ≥ 22 and pnpm 9.

## License

MIT — see [`LICENSE`](./LICENSE).

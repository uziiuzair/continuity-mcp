# Continuity

> ⚠️ **Alpha.** This is an early alpha release (`0.1.0-alpha.3`). Everything here —
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
- **Messaging & enforced coordination** — sessions message each other directly;
  contested edits are blocked until the other session responds (or a timeout
  expires — a silent teammate can never block you indefinitely), and
  response-required messages gate edits and turn-end until answered or dismissed
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

## How sessions talk (and why they can't ignore each other)

Awareness alone doesn't stop collisions — a model can read a warning and edit
anyway. Continuity enforces coordination with hooks, and every block expires on
a timeout, so a silent teammate can never wedge you:

1. **See.** Each session gets a coordination snapshot at start and a
   "what changed" delta on every prompt: new sessions, files others are
   touching, decisions, handoffs, and incoming messages.
2. **Talk.** `message_send` delivers a message to another session (or
   broadcasts); it arrives in the recipient's context on their next prompt.
   `message_respond` / `message_dismiss` answer it.
3. **Negotiate.** Editing a file another live session touched recently is
   **denied** until you send them a collision message
   (`message_send({ to_session, about_file, body })`) and they respond — or the
   block times out. A response (or explicit dismissal) lifts the block; fresh
   contention on the same file re-opens negotiation.
4. **Answer.** Messages marked response-required gate your next edit (one
   deterministic nudge) and block ending the turn until you respond, dismiss,
   or they expire. `decision_write` with `requires_ack` demands acknowledgment
   from every active session.

Configuration (plugin options):

| Option | Default | Meaning |
|---|---|---|
| `collisionGuard` | `negotiate` | `negotiate` blocks contested edits until coordinated; `warn` gives one warning then allows; `off` disables collision blocking |
| `messageTimeoutMinutes` | `10` | Lifetime of messages and enforcement blocks — the no-deadlock rule |

> **Team-mode note:** the messaging tools currently require the local flavor;
> the Worker routes for team mode are a follow-up (calls fail loudly against a
> team server until then).

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

### Troubleshooting

If Continuity seems inactive or inconsistent, run the doctor from the repo in
question:

```
node <plugin-install-path>/mcp/launch.mjs --doctor
```

It reports the Node version, why the repo gate is (in)active, which flavor is
running, whether the backend is reachable, and whether more than one continuity
plugin is installed and enabled (duplicate installs shadow each other's skills —
the SessionStart hook also warns about this in-session).

## Documentation

- [Architecture](./docs/architecture.md) — the two flavors, the `ContinuityBackend` seam, the data model
- [Local mode](./docs/local-mode.md) — zero-config single-machine setup
- [Team mode](./docs/team-mode.md) — deploying the Cloudflare Worker + Neon
- [Example team setup](./docs/examples/repo-allowlist.md) — scoping Continuity to specific repos

## Status

🚧 Early development. `0.1.0-alpha.3` adds direct messaging, collision
negotiation, and reply enforcement (see [`CHANGELOG.md`](./CHANGELOG.md)).
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) documents the original
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

# Security Policy

Continuity is an **early alpha** (`0.1.0-alpha.1`). It has not undergone a formal
security review, and several hardening measures (notably rate limiting) are not yet
implemented. Treat it accordingly and do not rely on it for production-critical or
sensitive workflows yet.

## Supported versions

| Version          | Supported                          |
|------------------|------------------------------------|
| `0.1.0-alpha.x`  | Best-effort only — **no guarantees** |
| anything older   | Not supported                      |

As an alpha, the schema, API surface, and plugin are unstable and may change
without notice. There is no LTS or backport guarantee.

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues, discussions, or
pull requests.**

Use private disclosure instead:

1. **Preferred:** open a private report via **GitHub Security Advisories**
   ("Report a vulnerability" under the repository's *Security* tab).
2. **Alternatively:** email the maintainer at `business@uziiuzair.com`.

Please include:

- The flavor affected (**local** SQLite or **team** Worker/Neon).
- A description of the issue and its impact.
- Steps to reproduce, and any proof-of-concept.

We'll acknowledge your report and work with you on a fix and coordinated
disclosure. Given the alpha status, response is best-effort.

## Security model

Continuity ships in two flavors with very different trust boundaries.

### Local flavor (SQLite)

- Runs **in-process** on a single machine against `~/.continuity/continuity.db`.
- **No authentication** — there is a single implicit local user. The trust
  boundary is your own machine's filesystem/user account.
- No network surface. Data never leaves the machine.

### Team flavor (Cloudflare Worker + Neon Postgres)

- **Authentication is Bearer API keys.** Each teammate has their own key; the
  server stores only an **HMAC hash** of the key (raw keys are shown once at
  creation and are never recoverable). The HMAC secret
  (`API_KEY_HMAC_SECRET`) must be high-entropy and stable — rotating it
  invalidates every issued key.
- **CORS is intentionally open.** The Worker does not restrict origins; the
  **API key is the security boundary**, not the browser origin. Anyone without a
  valid key is rejected regardless of origin.
- **No rate limiting yet.** This is a known alpha gap. The API has no
  per-key or per-IP throttling; deploy behind your own protections if exposed
  broadly.
- **Secrets management.** The Worker's `DATABASE_URL` and `API_KEY_HMAC_SECRET`
  are provided as Wrangler secrets in production (`wrangler secret put …`) and via
  a local `.dev.vars` file for `wrangler dev`. Never commit `.dev.vars` or any
  raw key.

## Privacy and data-capture surface

Continuity is a coordination tool, so it deliberately captures activity signals.
Understand what is collected before deploying — especially in team mode, where this
data is **visible to your teammates and to whoever operates the server**.

- **Repo gate defaults to any git repo.** With an empty `repoAllowlist`, the plugin
  activates in **every** git repository you open in Claude Code. Scope it with
  `repoAllowlist` if you only want coordination in specific repos.
- **Current focus = your prompt text.** The `UserPromptSubmit` hook sends the
  submitted prompt text as the session's "current focus." In team mode this focus
  is shown to other teammates' sessions.
- **Touched file paths.** The `PostToolUse` hook records the paths of files you
  edit (Write/Edit/MultiEdit/NotebookEdit). In team mode these paths are shared so
  others can avoid collisions.
- **Presence, decisions, claims, handoffs, audit log.** Session presence,
  decisions you record, task claims, handoffs, and an append-only audit log are all
  stored in the backend (locally on disk, or in Neon for team mode).

In **local mode** this data stays on your machine. In **team mode** it is
transmitted to and stored by the server you (or your team) operate; the server
operator can see it. Configure `repoAllowlist` and choose what you put in prompts
accordingly.

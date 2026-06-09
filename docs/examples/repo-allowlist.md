# Example: scoping Continuity to your team's repos

Continuity installs user-wide, so by default — with an empty `repoAllowlist` — it
activates in **any git repo** you open with Claude Code. That's ideal for solo
[local mode](../local-mode.md), but a team usually wants coordination scoped to just its
own repositories. The `repoAllowlist` config does exactly that.

This is **an example team setup**. Substitute your own host/owner/repo values.

## The `repoAllowlist` config

`repoAllowlist` is a comma-separated list of normalized git remotes in the form
`host/owner/repo` (lowercased, no `.git` suffix). When it's non-empty, Continuity
activates **only** in repos whose `origin` remote matches an entry — and stays inert
everywhere else.

Say a team works across two repos:

```
github.com/acme/web,github.com/acme/api
```

Set that string as the plugin's `repoAllowlist`. Now:

- In a checkout of `git@github.com:acme/web.git` → **active** (matches `github.com/acme/web`).
- In a checkout of `https://github.com/acme/api` → **active** (matches `github.com/acme/api`).
- In any other git repo (a personal project, a fork on a different remote) → **inert**.
- In a non-git directory → **inert** (always).

Remotes are normalized before matching, so HTTPS (`https://github.com/acme/web`), SSH
(`git@github.com:acme/web.git`), and `ssh://` forms all resolve to the same
`github.com/acme/web` and match the same entry.

## Pairing the allowlist with a flavor

The allowlist is independent of which flavor you run:

- **Team:** set `repoAllowlist` alongside `apiUrl` + `apiKey` so every teammate's sessions
  coordinate through the shared server, but only inside the team's repos. See
  [team mode](../team-mode.md).
- **Local:** you can set `repoAllowlist` even in local mode if you'd rather coordinate
  only inside specific repos instead of every git checkout. See
  [local mode](../local-mode.md).

A typical team config looks like:

```
apiUrl        = https://continuity-server.<your-account>.workers.dev
apiKey        = <your issued key>
repoAllowlist = github.com/acme/web,github.com/acme/api
```

With that in place, Continuity is on for the whole team across `web` and `api`, and quietly
out of the way everywhere else.

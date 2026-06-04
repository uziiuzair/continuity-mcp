---
name: Bug report
about: Report something that isn't working as expected
title: "[Bug] "
labels: bug
assignees: ''
---

## Describe the bug

A clear and concise description of what the bug is.

## Flavor

Which flavor are you running?

- [ ] Local (SQLite, zero-config)
- [ ] Team (Cloudflare Worker + Neon)

## Environment

- OS + version:
- Node version (`node --version`) — note: Continuity requires Node ≥ 22:
- pnpm version (`pnpm --version`):
- Continuity / plugin version:
- Claude Code version:

## Steps to reproduce

1.
2.
3.

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened.

## Relevant logs / output

Paste any relevant logs, error messages, or hook output. For local mode, it can
help to inspect `~/.continuity/continuity.db` (or your `dbPath` override). Please
redact prompts, file paths, or API keys you don't want to share.

```
<logs here>
```

## Additional context

Anything else that might help — repo gate config (`repoAllowlist`), whether it's
reproducible, multiple parallel sessions, worktrees, etc.

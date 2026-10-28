#!/usr/bin/env node
// PostToolUse on EnterWorktree / ExitWorktree: the session moved into (or out
// of) a worktree, which is a different working context — re-establish presence
// there. Observe-only on purpose: a WorktreeCreate/WorktreeRemove hook would
// replace Claude Code's own git worktree handling. Fail-open.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  runShim(input.cwd || process.cwd(), ["--checkin"])
}

main().catch(() => process.exit(0))

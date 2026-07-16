#!/usr/bin/env node
// PreToolUse (Write|Edit|MultiEdit|NotebookEdit): collision guard. If another
// live session touched the same file recently (per the others-activity cache
// the shim maintains in the state file), deny the edit ONCE with an instructive
// reason — the model coordinates and may simply retry to proceed. No network,
// no DB: a pure state-file read, so the hot path stays fast. Fail-open
// everywhere; set collisionGuard=false in the plugin config to disable.
import { repoRelative } from "./lib/common.mjs"
import { resolveRepoContext } from "./lib/gate.mjs"
import { collisionDecision } from "./lib/guard.mjs"
import { readState, writeState } from "./lib/state.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

const ALLOWED = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

function guardDisabled() {
  const v = (
    process.env.CONTINUITY_COLLISION_GUARD ??
    process.env.CLAUDE_PLUGIN_OPTION_COLLISIONGUARD ??
    process.env.CLAUDE_PLUGIN_OPTION_COLLISION_GUARD ??
    ""
  )
    .trim()
    .toLowerCase()
  return v === "false" || v === "off" || v === "0"
}

async function main() {
  if (guardDisabled()) return
  const input = await readStdinJson()
  const cwd = input.cwd || process.cwd()
  if (!ALLOWED.has(input.tool_name) || !input.tool_input?.file_path) return

  const allowlist =
    process.env.CONTINUITY_REPO_ALLOWLIST ??
    process.env.CLAUDE_PLUGIN_OPTION_REPOALLOWLIST ??
    process.env.CLAUDE_PLUGIN_OPTION_REPO_ALLOWLIST
  const repo = resolveRepoContext(cwd, allowlist)
  if (!repo) return

  const rel = repoRelative(repo.toplevel, input.tool_input.file_path)
  if (!rel) return

  const state = readState(repo.cwdHash)
  const decision = collisionDecision({
    entries: state?.others_activity,
    relPath: rel,
    warned: state?.collision_warned,
    nowMs: Date.now(),
  })
  if (!decision.warn) return

  // Remember the warning before emitting it, so the retry passes (warn-once).
  if (state) writeState(repo.cwdHash, { ...state, collision_warned: decision.warned })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    }),
  )
}

main().catch(() => process.exit(0))

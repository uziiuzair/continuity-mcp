#!/usr/bin/env node
// SessionStart: inject the coordination snapshot — the headline feature. Shells
// out to the bundled shim's `--snapshot` mode (which checks in and prints the
// snapshot for whichever flavor is configured). Fail-open everywhere.
import { nodeSupported, runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  const cwd = input.cwd || process.cwd()
  if (!nodeSupported()) {
    // Don't fail silently: tell the user (once per session, in context) why
    // the plugin is inactive instead of leaving them with a dead install.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            `[continuity] Inactive: Node ${process.versions.node} is too old. Continuity needs ` +
            `Node >= 22.5 (built-in node:sqlite). Install a newer Node and restart Claude Code. ` +
            `Please surface this warning to the user.`,
        },
      }),
    )
    return
  }
  const out = runShim(cwd, ["--snapshot"], { timeout: 12_000 })
  if (out?.trim()) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: out } }),
    )
  }
}

main().catch(() => process.exit(0))

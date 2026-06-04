#!/usr/bin/env node
// SessionStart: inject the coordination snapshot — the headline feature. Shells
// out to the bundled shim's `--snapshot` mode (which checks in and prints the
// snapshot for whichever flavor is configured). Fail-open everywhere.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  const cwd = input.cwd || process.cwd()
  const out = runShim(cwd, ["--snapshot"])
  if (out?.trim()) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: out } }),
    )
  }
}

main().catch(() => process.exit(0))

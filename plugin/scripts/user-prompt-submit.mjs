#!/usr/bin/env node
// UserPromptSubmit: sync this session's current focus from the prompt, so other
// sessions can see what you're working on. Best-effort, fail-open; the prompt is
// truncated server-side.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  const prompt = typeof input.prompt === "string" ? input.prompt.replace(/\s+/g, " ").trim() : ""
  if (!prompt) return
  runShim(input.cwd || process.cwd(), ["--focus", prompt.slice(0, 280)])
}

main().catch(() => process.exit(0))

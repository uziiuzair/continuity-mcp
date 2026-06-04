#!/usr/bin/env node
// npm bin entry for `continuity-mcp`. Loads the bundled server, which speaks the
// MCP protocol over stdio. The local backend uses node:sqlite, which needs
// --experimental-sqlite on Node 22.x–23.x (unflagged on 24+). Re-exec once with
// the flag if it isn't already present, so `npx continuity-mcp` just works.
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const bundle = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.mjs")

if (!process.execArgv.includes("--experimental-sqlite") && !process.env.CONTINUITY_REEXEC) {
  const r = spawnSync(process.execPath, ["--experimental-sqlite", bundle, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, CONTINUITY_REEXEC: "1", NODE_NO_WARNINGS: "1" },
  })
  process.exit(r.status ?? 0)
}

await import("../dist/index.mjs")

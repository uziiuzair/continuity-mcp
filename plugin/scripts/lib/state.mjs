import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Mirror of packages/mcp/src/state.ts. The state file is the rendezvous point
// between this hook and the long-lived MCP shim.

// Same resolution as state.ts dataDir(): CONTINUITY_STATE_DIR (an embedding
// host's own dir), then CLAUDE_PLUGIN_DATA, then the conventional path.
export function dataDir() {
  const own = process.env.CONTINUITY_STATE_DIR
  if (own && own.trim()) return own
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA
  if (fromEnv && fromEnv.trim()) return fromEnv
  return join(homedir(), ".claude", "plugins", "data", "continuity")
}

export function stateFilePath(cwdHash) {
  return join(dataDir(), "sessions", `${cwdHash}.json`)
}

export function readState(cwdHash) {
  const path = stateFilePath(cwdHash)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

export function writeState(cwdHash, state) {
  const path = stateFilePath(cwdHash)
  mkdirSync(dirname(path), { recursive: true })
  // Atomic write (tmp + rename) — mirror of state.ts; two processes write this
  // file, so a reader must never observe a torn JSON file.
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, path)
}

export function clearState(cwdHash) {
  try {
    rmSync(stateFilePath(cwdHash), { force: true })
  } catch {
    // ignore
  }
}

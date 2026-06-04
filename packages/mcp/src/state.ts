import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Shared session state, written by whichever process (SessionStart hook or this
// shim) checks in first and read by both so they converge on one session_id.
export type SessionState = {
  session_id: string | null
  agent_label: string | null
  project_scope: string | null
  pending_files: { path: string; tool: string }[]
  last_file_report_at: number | null
}

// State lives under the plugin's persistent data dir (survives plugin updates).
// CLAUDE_PLUGIN_DATA is exported to MCP subprocesses by Claude Code; fall back
// to the conventional path so the shim is testable standalone.
function dataDir(): string {
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA
  if (fromEnv && fromEnv.trim()) return fromEnv
  return join(homedir(), ".claude", "plugins", "data", "continuity")
}

export function stateFilePath(cwdHash: string): string {
  return join(dataDir(), "sessions", `${cwdHash}.json`)
}

export function readState(cwdHash: string): SessionState | null {
  const path = stateFilePath(cwdHash)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionState
  } catch {
    return null
  }
}

export function writeState(cwdHash: string, state: SessionState): void {
  const path = stateFilePath(cwdHash)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2))
}

export function clearState(cwdHash: string): void {
  try {
    rmSync(stateFilePath(cwdHash), { force: true })
  } catch {
    // ignore
  }
}

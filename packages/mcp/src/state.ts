import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { DeltaMemory } from "./deltas.js"
import type { CollisionSentMap, OthersActivityEntry, PendingInboundEntry } from "./guard.js"

// Shared session state, written by whichever process (SessionStart hook or this
// shim) checks in first and read by both so they converge on one session_id.
// The optional fields carry the mid-session coordination caches: delta_memory /
// delta_synced_at for --prompt-sync's announce-once baseline, others_activity +
// collision_warned for the PreToolUse collision guard (which must never touch
// the network, so it reads what --snapshot/--prompt-sync cached here). Three
// more support agent messaging: pending_inbound + message_warned back the ack
// gate (PreToolUse) and stop gate (Stop), and collision_sent tracks in-flight
// collision-negotiation messages for guard mode "negotiate".
export type SessionState = {
  session_id: string | null
  agent_label: string | null
  project_scope: string | null
  pending_files: { path: string; tool: string }[]
  last_file_report_at: number | null
  delta_memory?: DeltaMemory | null
  delta_synced_at?: number | null
  others_activity?: OthersActivityEntry[] | null
  collision_warned?: string[] | null
  pending_inbound?: PendingInboundEntry[] | null
  collision_sent?: CollisionSentMap | null
  message_warned?: string[] | null
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
  // Atomic write (tmp + rename): the file has two writers (the PostToolUse hook
  // and the long-lived shim), so a reader must never observe a torn JSON file.
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, path)
}

export function clearState(cwdHash: string): void {
  try {
    rmSync(stateFilePath(cwdHash), { force: true })
  } catch {
    // ignore
  }
}

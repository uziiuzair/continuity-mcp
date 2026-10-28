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
  // Continuity Loop state (tools/loop.ts). null once the loop stops.
  loop?: LoopState | null
  // The session's latest cwd, recorded on CwdChanged so loop_tick reports the
  // worktree the session moved into.
  current_dir?: string | null
}

// "Since the last tick" is an id diff against `seen` (pruned to what the
// latest tick still saw, so the lists never grow unbounded).
export type LoopState = {
  started_at: number
  task: string | null
  tier: 1 | 2 | 3
  quiet_streak: number
  own_work_done: boolean
  cron_job_id: string | null
  last_tick_at: number
  seen: { messages: string[]; responses: string[]; handoffs: string[]; decisions: string[]; sessions: string[] }
}

// State lives under the plugin's persistent data dir (survives plugin updates).
// CONTINUITY_STATE_DIR lets an embedding host (a harness running the MCP
// primitives in-process) keep this state in its own directory; otherwise
// CLAUDE_PLUGIN_DATA, which Claude Code exports to MCP subprocesses; fall back
// to the conventional path so the shim is testable standalone.
export function dataDir(): string {
  const own = process.env.CONTINUITY_STATE_DIR
  if (own && own.trim()) return own
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

// Record the backend session id for this identity. Spread prev first: the
// state file also carries the delta/collision caches, which a session-id
// refresh must not wipe.
export function persistSessionId(cwdHash: string, sessionId: string, agentLabel: string): void {
  const prev = readState(cwdHash)
  writeState(cwdHash, {
    ...prev,
    session_id: sessionId,
    agent_label: agentLabel,
    project_scope: prev?.project_scope ?? null,
    pending_files: prev?.pending_files ?? [],
    last_file_report_at: prev?.last_file_report_at ?? null,
  })
}

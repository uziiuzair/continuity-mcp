// Collision-guard decision for the PreToolUse hook: should this Write/Edit be
// interrupted because another live session touched the same file recently?
// Pure logic — the hook script mirrors the thin I/O around it (plugin/scripts/
// pre-tool-use.mjs) and reads the others-activity cache that --prompt-sync and
// --snapshot maintain in the session state file. Warn-once per path: the first
// attempt is denied with an instructive reason, the retry passes, so the model
// gets one deterministic nudge and never a hard wall.

import type { RecentFileActivity } from "@continuity/shared"

const DEFAULT_WINDOW_MS = 30 * 60_000
const MAX_WARNED = 100
const MAX_CACHE = 100

export type OthersActivityEntry = {
  path: string
  agent_label: string
  user_name: string
  touched_at: string
  session_id: string
}

export type CollisionDecision = { warn: false } | { warn: true; reason: string; warned: string[] }

// The others-activity cache written into the session state file by --snapshot
// and --prompt-sync, and read (without any network) by the PreToolUse hook.
// Same-repo only: file paths are repo-relative, so cross-repo entries would
// false-positive on common names like src/index.ts.
export function buildOthersCache(
  activity: RecentFileActivity[],
  repoFullName: string | null,
): OthersActivityEntry[] {
  return activity
    .filter((a) => a.repo_full_name === repoFullName)
    .slice(0, MAX_CACHE)
    .map((a) => ({
      path: a.file_path,
      agent_label: a.agent_label,
      user_name: a.user_name,
      touched_at: a.touched_at,
      session_id: a.agent_session_id,
    }))
}

function ago(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const m = Math.round(ms / 60_000)
  if (m < 1) return "under a minute ago"
  return `${m}m ago`
}

export function collisionDecision(args: {
  entries: OthersActivityEntry[] | null | undefined
  relPath: string
  warned: string[] | null | undefined
  nowMs: number
  windowMs?: number
}): CollisionDecision {
  const { entries, relPath, nowMs, windowMs = DEFAULT_WINDOW_MS } = args
  const warned = Array.isArray(args.warned) ? args.warned : []
  if (!Array.isArray(entries) || !relPath) return { warn: false }
  if (warned.includes(relPath)) return { warn: false }

  const hit = entries.find((e) => {
    if (!e || e.path !== relPath) return false
    const t = new Date(e.touched_at).getTime()
    return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= windowMs
  })
  if (!hit) return { warn: false }

  return {
    warn: true,
    reason:
      `Continuity: ${hit.agent_label} (${hit.user_name}) edited ${relPath} ${ago(hit.touched_at, nowMs)} ` +
      `in another live session. Check agent_file_activity_recent / coordinate before editing; ` +
      `retry the edit to proceed if you decide it's safe.`,
    warned: [...warned, relPath].slice(-MAX_WARNED),
  }
}

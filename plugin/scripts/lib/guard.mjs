// Mirror of packages/mcp/src/guard.ts (collisionDecision only — the cache is
// written by the shim, this side just reads it). If you change the window,
// warn-once semantics, or reason text there, change it here too.

const DEFAULT_WINDOW_MS = 30 * 60_000
const MAX_WARNED = 100

function ago(iso, nowMs) {
  const ms = nowMs - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const m = Math.round(ms / 60_000)
  if (m < 1) return "under a minute ago"
  return `${m}m ago`
}

export function collisionDecision({ entries, relPath, warned, nowMs, windowMs = DEFAULT_WINDOW_MS }) {
  const warnedList = Array.isArray(warned) ? warned : []
  if (!Array.isArray(entries) || !relPath) return { warn: false }
  if (warnedList.includes(relPath)) return { warn: false }

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
    warned: [...warnedList, relPath].slice(-MAX_WARNED),
  }
}

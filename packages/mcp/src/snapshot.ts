// Renders the SessionStart coordination snapshot — the headline feature. The
// plugin's SessionStart hook runs the shim with `--snapshot`, which checks in
// and prints this markdown; the hook injects it as additionalContext. Backend-
// agnostic: works identically for the local and remote flavors.

import type { ActiveSession, Decision, Handoff, RecentFileActivity } from "@continuity/shared"

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

function oneLine(s: string): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > 100 ? `${t.slice(0, 100)}…` : t
}

export function renderSnapshot(data: {
  active: ActiveSession[]
  activity: RecentFileActivity[]
  decisions: Decision[]
  handoffs: Handoff[]
  repoFullName: string | null
}): string {
  const { active, activity, decisions, handoffs, repoFullName } = data
  const lines = [
    "# Continuity is active for this session",
    "",
    "You're working alongside other Claude Code sessions (your own parallel ones, or teammates'). Treat coordination as part of the job:",
    "- Your current focus is tracked and shared automatically — no action needed.",
    "- Before editing a shared file, call `agent_file_activity_recent`; if another live session is already in it, coordinate or pick different work instead of colliding.",
    "- When you start a distinct piece of work, call `agent_list_active` first; if a session already covers it, hand off or step aside.",
    "- Record calls others must respect with `decision_write`, and claim issues with `task_claim`, so work isn't duplicated.",
    "- These are MCP tools from the `continuity` server. If they aren't loaded in your session (deferred tools), load them first (e.g. via ToolSearch); the `continuity:*` skills describe the same workflows.",
    "",
    `## Live snapshot (${new Date().toISOString()})`,
    "",
    "### Other active sessions",
  ]

  if (active.length === 0) lines.push("- none")
  else
    for (const s of active.slice(0, 10)) {
      const focus = s.current_focus ? ` · "${s.current_focus}"` : ""
      lines.push(`- ${s.agent_label} (${s.user_name})${focus} · ${ago(s.last_seen_at)}`)
    }

  lines.push("", "### Files other sessions are touching (30m)")
  if (activity.length === 0) lines.push("- none")
  else
    for (const a of activity.slice(0, 15)) {
      const overlap =
        repoFullName && a.repo_full_name === repoFullName
          ? " ⚠ same repo — coordinate before editing"
          : ""
      lines.push(`- ${a.file_path} ← ${a.user_name} (${ago(a.touched_at)})${overlap}`)
    }

  if (decisions.length > 0) {
    lines.push("", "### Recent decisions")
    for (const d of decisions.slice(0, 5)) {
      lines.push(`- [${d.decision_key}] ${oneLine(d.content)} (${ago(d.created_at)})`)
    }
  }

  if (handoffs.length > 0) {
    lines.push("", "### Pending handoffs for you")
    for (const h of handoffs.slice(0, 5)) {
      lines.push(`- ${oneLine(h.context)} (${ago(h.created_at)}) → accept via handoff_accept(${h.id})`)
    }
  }

  return lines.join("\n")
}

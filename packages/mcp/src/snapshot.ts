// Renders the SessionStart coordination snapshot — the headline feature. The
// plugin's SessionStart hook runs the shim with `--snapshot`, which checks in
// and prints this markdown; the hook injects it as additionalContext. Backend-
// agnostic: works identically for the local and remote flavors.

import { isAbsolute, relative } from "node:path"
import { type ActiveSession, type Decision, type Handoff, LOOP_TIERS, type Message, type RecentFileActivity } from "@continuity/shared"
import type { SessionState } from "./state.js"

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

// " · worktree <branch> @ <path>" for a session running in a linked worktree,
// else "". The path is relative to the repo's main checkout when inside it.
export function worktreeSegment(s: ActiveSession, mainCheckout: string | null | undefined): string {
  if (!s.is_worktree) return ""
  const branch = s.branch ?? "(detached)"
  let path = s.worktree_path ?? "?"
  if (mainCheckout && s.worktree_path) {
    const rel = relative(mainCheckout, s.worktree_path)
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) path = rel
  }
  return ` · worktree ${branch} @ ${path}`
}

export function renderSnapshot(data: {
  active: ActiveSession[]
  activity: RecentFileActivity[]
  decisions: Decision[]
  handoffs: Handoff[]
  messages: { inbound: Message[]; resolved: Message[] }
  repoFullName: string | null
  repoKey?: string | null
  mainCheckout?: string | null
  loop?: SessionState["loop"] | null
}): string {
  const { active, activity, decisions, handoffs, messages, repoFullName, repoKey, mainCheckout, loop } = data
  const lines = [
    "# Continuity is active for this session",
    "",
    "You're working alongside other Claude Code sessions (your own parallel ones, or teammates'). Treat coordination as part of the job:",
    "- Your current focus is tracked and shared automatically — no action needed.",
    "- Before editing a shared file, call `agent_file_activity_recent`; if another live session is already in it, coordinate or pick different work instead of colliding.",
    "- Contested edits are blocked until you coordinate: send `message_send({ to_session, about_file, body })` and the block lifts when they respond — or expires on its own. Answer messages you receive with `message_respond(id, response)` (or `message_dismiss(id, reason)`); response-required messages gate your edits and turn-end until handled.",
    "- When you start a distinct piece of work, call `agent_list_active` first; if a session already covers it, hand off or step aside.",
    "- When other sessions share this repo, start the Continuity Loop (`continuity:loop` skill) to keep polling for their messages and handoffs.",
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
      const sameRepo = repoKey && s.repo_key === repoKey ? " · same repo" : ""
      lines.push(`- ${s.agent_label} (${s.user_name})${worktreeSegment(s, mainCheckout)}${focus} · ${ago(s.last_seen_at)}${sameRepo}`)
    }
  if (!loop && repoKey && active.slice(0, 10).some((s) => s.repo_key === repoKey))
    lines.push("- Other sessions are active in this repo: start the Continuity Loop (`continuity:loop` skill) unless one is already running.")

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

  if (messages.inbound.length > 0) {
    lines.push("", "### Pending messages for you")
    for (const m of messages.inbound.slice(0, 5)) {
      // Decision-ack requests render in the same shape the delta renderer uses.
      if (m.kind === "decision") {
        lines.push(`- Decision [${m.related_key ?? "?"}] requires your ack → message_respond(${m.id}, "<ack>")`)
      } else {
        const req = m.requires_response ? " [response required]" : ""
        lines.push(`- ${oneLine(m.body)} → message_respond(${m.id}, "<reply>")${req}`)
      }
    }
  }

  if (loop) {
    const m = LOOP_TIERS[loop.tier - 1]?.minutes ?? "?"
    lines.push("", "### Continuity Loop", `- running · tier ${loop.tier} (${m} min) · quiet ${loop.quiet_streak} · ${loop.cron_job_id ? `cron ${loop.cron_job_id}` : "cron pending"}`)
  }

  return lines.join("\n")
}

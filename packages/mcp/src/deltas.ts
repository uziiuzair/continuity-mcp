// Renders mid-session coordination deltas — what changed since the last prompt.
// The plugin's UserPromptSubmit hook runs the shim with `--prompt-sync`, which
// calls this against the same backend queries the snapshot uses and injects any
// output as additionalContext. Memory lives in the session state file, so the
// baseline survives across the short-lived hook processes.

import type { ActiveSession, Decision, Handoff, Message, RecentFileActivity } from "@continuity/shared"
import { minutesLeft } from "./guard.js"

// Bounded so the state file can't grow without limit. Sessions/decisions/
// handoffs are tracked by id (announce-once, even if they drop out of the
// fetched window and return); file activity by a high-water mark on the
// backend's own touched_at clock, so machine clock skew can't hide or repeat
// activity.
const MAX_IDS = 50

export type DeltaMemory = {
  known_sessions: string[]
  known_decisions: string[]
  known_handoffs: string[]
  known_inbound: string[]
  known_resolved: string[]
  activity_high_water: string | null
}

export type SnapshotData = {
  active: ActiveSession[]
  activity: RecentFileActivity[]
  decisions: Decision[]
  handoffs: Handoff[]
  messages: { inbound: Message[]; resolved: Message[] }
  repoFullName: string | null
}

function ago(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime()
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

function remember(known: string[], fresh: string[]): string[] {
  // Newest last; drop from the front when over the cap.
  const merged = [...known]
  for (const id of fresh) if (!merged.includes(id)) merged.push(id)
  return merged.slice(-MAX_IDS)
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return new Date(b).getTime() > new Date(a).getTime() ? b : a
}

export function computeDeltas(
  memory: DeltaMemory | null,
  data: SnapshotData,
  nowMs: number,
): { text: string | null; memory: DeltaMemory } {
  const { active, activity, decisions, handoffs, messages, repoFullName } = data

  const highWater = activity.reduce<string | null>(
    (hw, a) => maxIso(hw, a.touched_at),
    memory?.activity_high_water ?? null,
  )

  // First run: seed the baseline silently — the SessionStart snapshot already
  // showed everything current, so announcing it again would be noise.
  if (!memory) {
    return {
      text: null,
      memory: {
        known_sessions: remember([], active.map((s) => s.session_id)),
        known_decisions: remember([], decisions.map((d) => d.id)),
        known_handoffs: remember([], handoffs.map((h) => h.id)),
        known_inbound: remember([], messages.inbound.map((m) => m.id)),
        known_resolved: remember([], messages.resolved.map((m) => m.id)),
        activity_high_water: highWater,
      },
    }
  }

  // Old state files predate the messages fields — guard so loading one doesn't crash.
  const knownInbound = memory.known_inbound ?? []
  const knownResolved = memory.known_resolved ?? []

  const newSessions = active.filter((s) => !memory.known_sessions.includes(s.session_id))
  const newActivity = memory.activity_high_water
    ? activity.filter(
        (a) => new Date(a.touched_at).getTime() > new Date(memory.activity_high_water as string).getTime(),
      )
    : activity
  const newDecisions = decisions.filter((d) => !memory.known_decisions.includes(d.id))
  const newHandoffs = handoffs.filter((h) => !memory.known_handoffs.includes(h.id))
  const newInbound = messages.inbound.filter((m) => !knownInbound.includes(m.id))
  const newResolved = messages.resolved.filter((m) => !knownResolved.includes(m.id))

  const nextMemory: DeltaMemory = {
    known_sessions: remember(memory.known_sessions, active.map((s) => s.session_id)),
    known_decisions: remember(memory.known_decisions, decisions.map((d) => d.id)),
    known_handoffs: remember(memory.known_handoffs, handoffs.map((h) => h.id)),
    known_inbound: remember(knownInbound, messages.inbound.map((m) => m.id)),
    known_resolved: remember(knownResolved, messages.resolved.map((m) => m.id)),
    activity_high_water: highWater,
  }

  if (
    !newSessions.length &&
    !newActivity.length &&
    !newDecisions.length &&
    !newHandoffs.length &&
    !newInbound.length &&
    !newResolved.length
  ) {
    return { text: null, memory: nextMemory }
  }

  const lines = ["## Continuity update (since your last prompt)"]

  for (const s of newSessions.slice(0, 10)) {
    const focus = s.current_focus ? ` · "${oneLine(s.current_focus)}"` : ""
    lines.push(`- New session: ${s.agent_label} (${s.user_name})${focus}`)
  }
  for (const a of newActivity.slice(0, 15)) {
    const overlap =
      repoFullName && a.repo_full_name === repoFullName
        ? " ⚠ same repo — coordinate before editing"
        : ""
    lines.push(`- ${a.file_path} ← ${a.user_name} (${ago(a.touched_at, nowMs)})${overlap}`)
  }
  for (const d of newDecisions.slice(0, 5)) {
    lines.push(`- New decision: [${d.decision_key}] ${oneLine(d.content)}`)
  }
  for (const h of newHandoffs.slice(0, 5)) {
    lines.push(`- New handoff for you: ${oneLine(h.context)} → accept via handoff_accept(${h.id})`)
  }
  for (const m of newInbound.slice(0, 5)) {
    const who = `${m.from_agent_label ?? "another session"} (${m.from_user_name ?? "?"})`
    if (m.kind === "decision") {
      lines.push(`- Decision [${m.related_key ?? "?"}] requires your ack → message_respond(${m.id}, "<ack>")`)
    } else {
      const req = m.requires_response
        ? ` [response required, expires in ${Math.max(1, minutesLeft(m.expires_at, nowMs))}m]`
        : ""
      lines.push(`- Message from ${who}: "${oneLine(m.body)}" → respond via message_respond(${m.id}, "<reply>")${req}`)
    }
  }
  for (const m of newResolved.slice(0, 5)) {
    const verb = m.status === "dismissed" ? "Your message was dismissed" : "Response received"
    const re = m.kind === "collision" && m.related_key ? ` (re: your collision message on ${m.related_key})` : ""
    lines.push(`- ${verb}: "${oneLine(m.response ?? "")}"${re}`)
  }

  return { text: lines.join("\n"), memory: nextMemory }
}

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

// The shared contest predicate: another live session touched this path within
// the activity window. Both collision guards (v1 warn-once and v2 modes) key
// off it.
function isContested(
  entries: OthersActivityEntry[] | null | undefined,
  relPath: string,
  nowMs: number,
  windowMs: number,
): OthersActivityEntry | undefined {
  return (entries ?? []).find((e) => {
    if (!e || e.path !== relPath) return false
    const t = new Date(e.touched_at).getTime()
    return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= windowMs
  })
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

  const hit = isContested(entries, relPath, nowMs, windowMs)
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

export type GuardMode = "negotiate" | "warn" | "off"

// Legacy plugin configs stored a boolean collisionGuard; map those onto the
// mode enum. Unknown values fall back to the default (negotiate).
export function parseGuardMode(raw: string | undefined): GuardMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "off" || v === "false" || v === "0") return "off"
  if (v === "warn") return "warn"
  return "negotiate"
}

// Inbound-message cache entry the ack/stop gates read from the state file.
// Written by --prompt-sync/--snapshot; pruned synchronously by the
// message_respond/message_dismiss tool handlers. Flattened cache shape of a
// shared Message (from_label/from_user = from_agent_label/from_user_name),
// kept complete for renderers even where gates read only a subset.
export type PendingInboundEntry = {
  message_id: string
  from_label: string
  from_user: string
  body: string
  kind: string
  related_key: string | null
  requires_response: boolean
  expires_at: string
}

export type CollisionSentMap = Record<string, { message_id: string; expires_at: string; status: string }>

export type GuardResult = { action: "allow" } | { action: "deny"; reason: string; warned?: string[] }

// Shared with deltas.ts for expiry countdowns. NaN-safe: a malformed
// timestamp renders as 0 rather than "NaNm".
export function minutesLeft(expiresAt: string, nowMs: number): number {
  const mins = Math.ceil((new Date(expiresAt).getTime() - nowMs) / 60_000)
  return Number.isFinite(mins) ? Math.max(0, mins) : 0
}

// Reasons list at most five items; the suffix keeps the count honest when the
// list is truncated.
function listWithOverflow(due: PendingInboundEntry[], render: (m: PendingInboundEntry) => string): string {
  const shown = due.slice(0, 5).map(render).join("; ")
  return due.length > 5 ? `${shown}; …and ${due.length - 5} more` : shown
}

// Mode-aware collision decision. warn = the original warn-once behavior;
// negotiate = deny until a collision message on the path is answered or
// expires (the timeout-override rule — a block must never outlive its window).
export function collisionDecisionV2(args: {
  mode: GuardMode
  entries: OthersActivityEntry[] | null | undefined
  relPath: string
  warned: string[] | null | undefined
  collisionSent: CollisionSentMap | null | undefined
  nowMs: number
  windowMs?: number
}): GuardResult {
  const { mode, entries, relPath, nowMs, windowMs = DEFAULT_WINDOW_MS } = args
  if (mode === "off") return { action: "allow" }

  if (mode === "warn") {
    const base = collisionDecision({ entries, relPath, warned: args.warned, nowMs, windowMs })
    return base.warn
      ? { action: "deny", reason: base.reason, warned: base.warned }
      : { action: "allow" }
  }

  // negotiate
  const other = isContested(entries, relPath, nowMs, windowMs)
  if (!other) return { action: "allow" }

  const sent = args.collisionSent?.[relPath]
  if (!sent) {
    return {
      action: "deny",
      reason:
        `Continuity: ${other.agent_label} (${other.user_name}) is working in ${relPath}. ` +
        `Coordinate first: message_send({ to_session: "${other.session_id}", about_file: "${relPath}", body: "<what you want to change>" }). ` +
        `The block lifts when they respond, or expires on its own — pick other work meanwhile.`,
    }
  }
  // Responded and dismissed both resolve the gate — the resolution text reaches
  // the sender via prompt-sync, so proceeding is informed, not blind.
  if (sent.status !== "pending") return { action: "allow" }
  const expiresMs = new Date(sent.expires_at).getTime()
  // Timeout override (and fail-open on malformed timestamps): a block must
  // never outlive its window.
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return { action: "allow" }
  return {
    action: "deny",
    reason:
      `Continuity: still awaiting a response on ${relPath} (expires in ${minutesLeft(sent.expires_at, nowMs)}m). ` +
      `Work elsewhere until then; the block lifts automatically on response or expiry.`,
  }
}

// Deny-once gate on edits while response-required messages sit unanswered.
// One nudge, keyed by message id; the Stop gate is the backstop.
export function ackGateDecision(args: {
  pendingInbound: PendingInboundEntry[] | null | undefined
  messageWarned: string[] | null | undefined
  nowMs: number
}): GuardResult {
  const warned = Array.isArray(args.messageWarned) ? args.messageWarned : []
  const due = (args.pendingInbound ?? []).filter(
    (m) =>
      m?.requires_response &&
      new Date(m.expires_at).getTime() > args.nowMs &&
      !warned.includes(m.message_id),
  )
  if (due.length === 0) return { action: "allow" }
  const list = listWithOverflow(due, (m) => `${m.message_id} from ${m.from_label}: "${m.body.slice(0, 80)}"`)
  return {
    action: "deny",
    reason:
      `Continuity: ${due.length} message(s) require your response before more edits — ${list}. ` +
      `Use message_respond(id, response) or message_dismiss(id, reason); they expire on their own otherwise. ` +
      `Retry the edit to proceed.`,
    warned: [...warned, ...due.map((m) => m.message_id)].slice(-MAX_WARNED),
  }
}

// Turn-end gate: fresh response-required items block the Stop once per stop
// chain (stop_hook_active guards the loop); expired items never block.
export function stopGateDecision(args: {
  pendingInbound: PendingInboundEntry[] | null | undefined
  stopHookActive: boolean
  nowMs: number
}): { block: false } | { block: true; reason: string } {
  if (args.stopHookActive) return { block: false }
  const due = (args.pendingInbound ?? []).filter(
    (m) => m?.requires_response && new Date(m.expires_at).getTime() > args.nowMs,
  )
  if (due.length === 0) return { block: false }
  const list = listWithOverflow(
    due,
    (m) => `message_respond("${m.message_id}", …) — from ${m.from_label}: "${m.body.slice(0, 80)}"`,
  )
  return {
    block: true,
    reason: `Continuity: before ending the turn, answer or dismiss pending message(s): ${list}. Use message_dismiss(id, reason) if a response isn't warranted.`,
  }
}

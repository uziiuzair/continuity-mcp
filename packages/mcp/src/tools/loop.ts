import type { ActiveSession, Decision, Handoff, Message } from "@continuity/shared"
import { LOOP_CRON_MARKER, LOOP_TIERS } from "@continuity/shared"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { resolveRepoContext } from "../gate.js"
import { type LoopVerdict, cronFor, stepLadder } from "../loop.js"
import { type LoopState, type SessionState, readState, writeState } from "../state.js"
import { type ToolContext, asText } from "./util.js"

// Everything one tick diffs against `loop.seen`.
export type LoopTickData = {
  sameRepoActive: ActiveSession[]
  inbound: Message[]
  resolved: Message[]
  handoffs: Handoff[]
  decisions: Decision[]
}

export type LoopTickInput = { start?: boolean; task?: string; own_work_done?: boolean; cron_job_id?: string }

export type SessionSummary = {
  session_id: string
  agent_label?: string
  current_focus?: string | null
  worktree_path?: string | null
  branch?: string | null
  is_worktree?: boolean
}

export type LoopTickNew = {
  messages: Message[]
  responses: Message[]
  handoffs: Handoff[]
  decisions: Decision[]
  sessions_joined: SessionSummary[]
  // Only ids are remembered, so a departed session is reported by id.
  sessions_left: SessionSummary[]
}

export type LoopTickResult =
  | {
      ok: true
      new: LoopTickNew
      active: boolean
      loop: {
        tier: 1 | 2 | 3
        interval_minutes: number
        quiet_streak: number
        own_work_done: boolean
        cron_job_id: string | null
      }
      verdict: LoopVerdict
    }
  | { ok: false; reason: "no_loop"; hint: string }

type TickKind = "no_loop" | "start" | "already_running" | "set_cron" | "tick"

// Classify a call before any I/O: only "start" and "tick" need backend data.
export function tickKind(prev: LoopState | null | undefined, input: LoopTickInput): TickKind {
  if (input.start) return prev ? "already_running" : "start"
  if (!prev) return "no_loop"
  if (input.cron_job_id !== undefined && !input.own_work_done) return "set_cron"
  return "tick"
}

const minutesFor = (tier: 1 | 2 | 3): number => (LOOP_TIERS[tier - 1] as (typeof LOOP_TIERS)[number]).minutes

const emptyNew = (): LoopTickNew => ({
  messages: [],
  responses: [],
  handoffs: [],
  decisions: [],
  sessions_joined: [],
  sessions_left: [],
})

function seenFrom(data: LoopTickData): LoopState["seen"] {
  return {
    messages: data.inbound.map((m) => m.id),
    responses: data.resolved.map((m) => m.id),
    handoffs: data.handoffs.map((h) => h.id),
    decisions: data.decisions.map((d) => d.id),
    sessions: data.sameRepoActive.map((s) => s.session_id),
  }
}

function summarize(s: ActiveSession): SessionSummary {
  return {
    session_id: s.session_id,
    agent_label: s.agent_label,
    current_focus: s.current_focus,
    worktree_path: s.worktree_path,
    branch: s.branch,
    is_worktree: s.is_worktree,
  }
}

function ok(loop: LoopState, news: LoopTickNew, active: boolean, verdict: LoopVerdict): LoopTickResult {
  return {
    ok: true,
    new: news,
    active,
    loop: {
      tier: loop.tier,
      interval_minutes: minutesFor(loop.tier),
      quiet_streak: loop.quiet_streak,
      own_work_done: loop.own_work_done,
      cron_job_id: loop.cron_job_id,
    },
    verdict,
  }
}

const keep = (loop: LoopState, reason: string): LoopVerdict => {
  const minutes = minutesFor(loop.tier)
  return { action: "keep", interval_minutes: minutes, cron: cronFor(minutes), reason }
}

// Pure: the next loop state (null = no loop / stopped) and the tool result.
export function computeTick(
  prev: LoopState | null | undefined,
  data: LoopTickData,
  input: LoopTickInput,
  now: number,
): { loop: LoopState | null; result: LoopTickResult } {
  const kind = tickKind(prev, input)

  if (kind === "start") {
    const loop: LoopState = {
      started_at: now,
      task: input.task ?? null,
      tier: 1,
      quiet_streak: 0,
      own_work_done: false,
      cron_job_id: input.cron_job_id ?? null,
      last_tick_at: now,
      // Seeded from current data so pre-existing items are never "new".
      seen: seenFrom(data),
    }
    const minutes = minutesFor(1)
    const verdict: LoopVerdict = { action: "reschedule", interval_minutes: minutes, cron: cronFor(minutes), reason: "loop started" }
    return { loop, result: ok(loop, emptyNew(), false, verdict) }
  }
  if (!prev) return { loop: null, result: { ok: false, reason: "no_loop", hint: "CronDelete this job" } }

  if (kind === "already_running" || kind === "set_cron") {
    const loop = input.cron_job_id !== undefined ? { ...prev, cron_job_id: input.cron_job_id } : prev
    if (kind === "already_running" && loop.cron_job_id === null) {
      // No cron was ever recorded (e.g. CronCreate failed or the session was
      // restarted): ask for one at the current tier so the loop can recover.
      const minutes = minutesFor(loop.tier)
      const verdict: LoopVerdict = {
        action: "reschedule",
        interval_minutes: minutes,
        cron: cronFor(minutes),
        reason: "loop running, no cron recorded",
      }
      return { loop, result: ok(loop, emptyNew(), false, verdict) }
    }
    const reason = kind === "already_running" ? "loop already running" : "cron job id recorded"
    return { loop, result: ok(loop, emptyNew(), false, keep(loop, reason)) }
  }

  // A real tick: diff against `seen`, then step the ladder.
  const isNew = (seen: string[]) => {
    const set = new Set(seen)
    return (id: string) => !set.has(id)
  }
  const current = seenFrom(data)
  const currentSessions = new Set(current.sessions)
  const newMessages = isNew(prev.seen.messages)
  const newResponses = isNew(prev.seen.responses)
  const newHandoffs = isNew(prev.seen.handoffs)
  const newDecisions = isNew(prev.seen.decisions)
  const newSessions = isNew(prev.seen.sessions)
  const news: LoopTickNew = {
    messages: data.inbound.filter((m) => newMessages(m.id)),
    responses: data.resolved.filter((m) => newResponses(m.id)),
    handoffs: data.handoffs.filter((h) => newHandoffs(h.id)),
    decisions: data.decisions.filter((d) => newDecisions(d.id)),
    sessions_joined: data.sameRepoActive.filter((s) => newSessions(s.session_id)).map(summarize),
    sessions_left: prev.seen.sessions.filter((id) => !currentSessions.has(id)).map((id) => ({ session_id: id })),
  }
  // Decisions and session join/leave are reported but never count as activity.
  const active = news.messages.length + news.responses.length + news.handoffs.length > 0

  const { next, verdict } = stepLadder(
    { tier: prev.tier, quiet_streak: prev.quiet_streak, own_work_done: prev.own_work_done },
    { active, markDone: input.own_work_done === true },
  )
  const loop: LoopState = {
    ...prev,
    ...next,
    cron_job_id: input.cron_job_id ?? prev.cron_job_id,
    last_tick_at: now,
    // Pruned to what this tick saw, so `seen` never grows unbounded.
    seen: current,
  }
  return { loop: verdict.action === "stop" ? null : loop, result: ok(loop, news, active, verdict) }
}

// Backend reads for one tick. Errors propagate: a partial fetch would prune
// `seen` and re-report old items, so a failed tick is better left unconsumed.
// One exception: the team-mode Worker has no /messages routes yet, so in
// remote mode a messagePending failure reads as "no messages" and the loop
// runs on handoffs alone.
// Responses are read since the previous tick (not the backend's 30-minute
// default), since slow tiers tick 30+ minutes apart. Inbound needs no window:
// pending messages stay pending until answered, so they cannot age out.
export async function fetchLoopTickData(
  ctx: ToolContext,
  sessionId: string,
  prev: LoopState | null,
): Promise<LoopTickData> {
  const resolvedSince = prev ? { resolved_since: new Date(prev.last_tick_at).toISOString() } : {}
  const [active, pending, handoffs, decisions] = await Promise.all([
    ctx.backend.listActive({ same_repo_key: ctx.repoKey, exclude_session: sessionId, max_age_seconds: 300 }),
    ctx.mode === "remote"
      ? ctx.backend
          .messagePending({ session_id: sessionId, ...resolvedSince })
          .catch(() => ({ inbound: [], resolved: [] }))
      : ctx.backend.messagePending({ session_id: sessionId, ...resolvedSince }),
    ctx.backend.handoffPending({ agent_session_id: sessionId }),
    ctx.backend.decisionRecent({ limit: 10 }),
  ])
  return {
    sameRepoActive: active.sessions,
    inbound: pending.inbound,
    resolved: pending.resolved,
    handoffs: handoffs.handoffs,
    decisions: decisions.decisions,
  }
}

const emptyData = (): LoopTickData => ({ sameRepoActive: [], inbound: [], resolved: [], handoffs: [], decisions: [] })

// The worktree follows a mid-session move: prefer the recorded current_dir.
function sessionWorktree(ctx: ToolContext, state: SessionState | null) {
  const dir = state?.current_dir
  const wt = (dir && resolveRepoContext(dir, process.env.CONTINUITY_REPO_ALLOWLIST)?.worktree) || ctx.worktree
  return { is_worktree: wt.is_worktree, path: wt.path, branch: wt.branch, main_checkout: wt.main_checkout }
}

export function registerLoopTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "loop_tick",
    {
      title: "Continuity Loop tick",
      description:
        `Drive the Continuity Loop (periodic check-ins with sibling sessions). Call with { start: true, task } to start it, then pass the CronCreate job id back via { cron_job_id }. Call with no arguments on each ${LOOP_CRON_MARKER} cron tick; pass { own_work_done: true } once your own task is finished. ` +
        "Returns what is new since the last tick (messages, responses, handoffs, decisions, sessions joined/left) and a verdict to follow: keep = do nothing; reschedule = CronDelete the old job, CronCreate with the returned cron, pass the new id back; stop = CronDelete the job and tell the user the loop ended. If it returns no_loop, CronDelete this job.",
      inputSchema: {
        start: z.boolean().optional().describe("Start the loop (idempotent: an existing loop is left unchanged)."),
        task: z.string().optional().describe("Your assigned task, stored on start."),
        own_work_done: z.boolean().optional().describe("Your own task is finished: back off one tier."),
        cron_job_id: z.string().optional().describe("The loop's CronCreate job id. Alone, it only records the id."),
      },
    },
    async (input) => {
      const sessionId = ctx.getSessionId()
      if (!sessionId) return asText({ ok: false, reason: "no_active_session" })
      const { cwdHash } = ctx
      const state = readState(cwdHash)
      const prev = state?.loop ?? null
      const kind = tickKind(prev, input)
      // Taken before the fetch, so a reply landing mid-fetch is still newer
      // than last_tick_at and gets picked up by the next tick.
      const now = Date.now()
      const data = kind === "start" || kind === "tick" ? await fetchLoopTickData(ctx, sessionId, prev) : emptyData()
      const { loop, result } = computeTick(prev, data, input, now)

      if (kind !== "no_loop") {
        const latest: SessionState = readState(cwdHash) ?? {
          session_id: sessionId,
          agent_label: null,
          project_scope: null,
          pending_files: [],
          last_file_report_at: null,
        }
        writeState(cwdHash, { ...latest, loop })
      }
      if (!result.ok) return asText(result)
      const session = { id: sessionId, label: state?.agent_label ?? null, worktree: sessionWorktree(ctx, state) }
      const { ok: _ok, ...body } = result
      return asText({ ok: true, session, ...body })
    },
  )
}

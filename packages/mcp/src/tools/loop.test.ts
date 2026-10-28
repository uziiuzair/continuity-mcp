import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ActiveSession, ContinuityBackend, Decision, Handoff, Message } from "@continuity/shared"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type LoopState, type SessionState, readState, writeState } from "../state.js"
import { type LoopTickData, computeTick, registerLoopTools } from "./loop.js"
import type { ToolContext } from "./util.js"

const msg = (id: string): Message => ({
  id,
  from_agent_session_id: "other",
  to_agent_session_id: "me",
  repo_full_name: null,
  kind: "message",
  body: `body ${id}`,
  requires_response: false,
  related_key: null,
  status: "pending",
  response: null,
  created_at: "2026-10-28T00:00:00Z",
  responded_at: null,
  expires_at: "2026-10-28T01:00:00Z",
} as Message)

const handoff = (id: string): Handoff => ({
  id,
  from_agent_session_id: "other",
  to_agent_session_id: "me",
  to_user_id: null,
  project_scope: null,
  context: "ctx",
  state: null,
  suggested_next_actions: null,
  status: "pending",
  created_at: "2026-10-28T00:00:00Z",
  accepted_at: null,
  completed_at: null,
} as Handoff)

const decision = (id: string): Decision => ({
  id,
  decision_key: `key-${id}`,
  content: "c",
  decision_type: "architecture",
  project_scope: null,
  author_user_id: null,
  author_agent_session_id: "other",
  status: "active",
  supersedes: null,
  created_at: "2026-10-28T00:00:00Z",
} as Decision)

const session = (id: string): ActiveSession => ({
  session_id: id,
  agent_label: `label-${id}`,
  user_name: "u",
  project_scope: null,
  current_focus: "focus",
  claimed_issue_number: null,
  claimed_repo_full_name: null,
  worktree_path: `/wt/${id}`,
  branch: `feat/${id}`,
  is_worktree: true,
  repo_key: "github.com/o/r",
  status: "active",
  last_seen_at: "2026-10-28T00:00:00Z",
} as ActiveSession)

const empty = (): LoopTickData => ({ sameRepoActive: [], inbound: [], resolved: [], handoffs: [], decisions: [] })
const NOW = 1_000_000

function started(data: LoopTickData = empty()): LoopState {
  const { loop } = computeTick(null, data, { start: true, task: "t" }, NOW)
  if (!loop) throw new Error("start returned no loop")
  return loop
}

describe("computeTick", () => {
  it("start seeds seen, so pre-existing messages are not new", () => {
    const data = { ...empty(), inbound: [msg("m1")], handoffs: [handoff("h1")], sameRepoActive: [session("s1")] }
    const r = computeTick(null, data, { start: true, task: "build x" }, NOW)
    expect(r.loop).toMatchObject({ task: "build x", tier: 1, quiet_streak: 0, own_work_done: false, started_at: NOW })
    expect(r.loop?.seen).toEqual({ messages: ["m1"], responses: [], handoffs: ["h1"], decisions: [], sessions: ["s1"] })
    expect(r.result).toMatchObject({
      ok: true,
      verdict: { action: "reschedule", interval_minutes: 5, cron: "*/5 * * * *", reason: "loop started" },
    })

    const tick = computeTick(r.loop, data, {}, NOW + 1)
    expect(tick.result).toMatchObject({ ok: true, active: false })
    if (!tick.result.ok) throw new Error("expected ok")
    expect(tick.result.new.messages).toEqual([])
    expect(tick.result.new.handoffs).toEqual([])
    expect(tick.result.new.sessions_joined).toEqual([])
  })

  it("new inbound message → active, appears in new.messages", () => {
    const r = computeTick(started(), { ...empty(), inbound: [msg("m1")] }, {}, NOW + 1)
    if (!r.result.ok) throw new Error("expected ok")
    expect(r.result.active).toBe(true)
    expect(r.result.new.messages.map((m) => m.id)).toEqual(["m1"])
    expect(r.loop?.seen.messages).toEqual(["m1"])
    expect(r.loop?.last_tick_at).toBe(NOW + 1)
  })

  it("new resolved response → active", () => {
    const r = computeTick(started(), { ...empty(), resolved: [msg("r1")] }, {}, NOW + 1)
    if (!r.result.ok) throw new Error("expected ok")
    expect(r.result.active).toBe(true)
    expect(r.result.new.responses.map((m) => m.id)).toEqual(["r1"])
  })

  it("new handoff → active", () => {
    const r = computeTick(started(), { ...empty(), handoffs: [handoff("h1")] }, {}, NOW + 1)
    if (!r.result.ok) throw new Error("expected ok")
    expect(r.result.active).toBe(true)
    expect(r.result.new.handoffs.map((h) => h.id)).toEqual(["h1"])
  })

  it("new decision only → not active, listed in new.decisions", () => {
    const r = computeTick(started(), { ...empty(), decisions: [decision("d1")] }, {}, NOW + 1)
    if (!r.result.ok) throw new Error("expected ok")
    expect(r.result.active).toBe(false)
    expect(r.result.new.decisions.map((d) => d.id)).toEqual(["d1"])
    expect(r.loop?.quiet_streak).toBe(1)
  })

  it("same-repo session joined → listed, not active", () => {
    const loop = started({ ...empty(), sameRepoActive: [session("old")] })
    const r = computeTick(loop, { ...empty(), sameRepoActive: [session("s1")] }, {}, NOW + 1)
    if (!r.result.ok) throw new Error("expected ok")
    expect(r.result.active).toBe(false)
    expect(r.result.new.sessions_joined).toEqual([
      { session_id: "s1", agent_label: "label-s1", current_focus: "focus", worktree_path: "/wt/s1", branch: "feat/s1", is_worktree: true },
    ])
    expect(r.result.new.sessions_left).toEqual([{ session_id: "old" }])
    expect(r.loop?.seen.sessions).toEqual(["s1"])
  })

  it("start twice → second is keep, state unchanged", () => {
    const loop = { ...started(), quiet_streak: 3 }
    const r = computeTick(loop, { ...empty(), inbound: [msg("m9")] }, { start: true, task: "other" }, NOW + 5)
    expect(r.loop).toEqual(loop)
    expect(r.result).toMatchObject({ ok: true, active: false, verdict: { action: "keep", interval_minutes: 5 } })
    if (!r.result.ok) throw new Error("expected ok")
    expect(r.result.new.messages).toEqual([])
  })

  it("no loop → no_loop", () => {
    expect(computeTick(null, empty(), {}, NOW)).toEqual({
      loop: null,
      result: { ok: false, reason: "no_loop", hint: "CronDelete this job" },
    })
    expect(computeTick(null, empty(), { cron_job_id: "job" }, NOW).result).toMatchObject({ ok: false, reason: "no_loop" })
    expect(computeTick(null, empty(), { own_work_done: true }, NOW).result).toMatchObject({ ok: false, reason: "no_loop" })
  })

  it("stop verdict clears loop", () => {
    const loop: LoopState = { ...started(), tier: 3, quiet_streak: 1, own_work_done: true }
    const r = computeTick(loop, empty(), {}, NOW + 1)
    expect(r.loop).toBeNull()
    expect(r.result).toMatchObject({ ok: true, verdict: { action: "stop" } })
  })

  it("cron_job_id-only call does not advance streak", () => {
    const loop = { ...started(), quiet_streak: 2 }
    const r = computeTick(loop, { ...empty(), inbound: [msg("m1")] }, { cron_job_id: "job-7" }, NOW + 1)
    expect(r.loop).toEqual({ ...loop, cron_job_id: "job-7" })
    expect(r.result).toMatchObject({
      ok: true,
      active: false,
      loop: { tier: 1, quiet_streak: 2, cron_job_id: "job-7" },
      verdict: { action: "keep", interval_minutes: 5, cron: "*/5 * * * *" },
    })
  })

  it("own_work_done drops a tier on a real tick", () => {
    const r = computeTick(started(), empty(), { own_work_done: true }, NOW + 1)
    expect(r.loop).toMatchObject({ tier: 2, quiet_streak: 0, own_work_done: true, last_tick_at: NOW + 1 })
    expect(r.result).toMatchObject({ ok: true, verdict: { action: "reschedule", interval_minutes: 10 } })
  })

  it("seen is pruned to ids still present", () => {
    const loop = started({ ...empty(), inbound: [msg("m1"), msg("m2")] })
    const r = computeTick(loop, { ...empty(), inbound: [msg("m2")] }, {}, NOW + 1)
    expect(r.loop?.seen.messages).toEqual(["m2"])
  })
})

// ---- Handler: state file + backend wiring ----

type Call = { method: string; args: unknown }
type Handler = (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>

const HASH = "loophash"
let dir: string
let savedStateDir: string | undefined
let calls: Call[]
let backendData: LoopTickData

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "continuity-loop-"))
  savedStateDir = process.env.CONTINUITY_STATE_DIR
  process.env.CONTINUITY_STATE_DIR = dir
  calls = []
  backendData = empty()
})

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.CONTINUITY_STATE_DIR
  else process.env.CONTINUITY_STATE_DIR = savedStateDir
  rmSync(dir, { recursive: true, force: true })
})

function tool(sessionId: string | null = "me"): (input?: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const record =
    <T>(method: string, out: () => T) =>
    async (args: unknown) => {
      calls.push({ method, args })
      return out()
    }
  const backend = {
    listActive: record("listActive", () => ({ sessions: backendData.sameRepoActive })),
    messagePending: record("messagePending", () => ({ inbound: backendData.inbound, resolved: backendData.resolved })),
    handoffPending: record("handoffPending", () => ({ handoffs: backendData.handoffs })),
    decisionRecent: record("decisionRecent", () => ({ decisions: backendData.decisions })),
  } as unknown as ContinuityBackend
  const ctx: ToolContext = {
    backend,
    getSessionId: () => sessionId,
    repoFullName: "o/r",
    mode: "local",
    cwdHash: HASH,
    repoKey: "github.com/o/r",
    worktree: { is_worktree: false, path: "/repo", branch: "main", main_checkout: null, claude_managed: false },
  }
  let handler: Handler | undefined
  const server = {
    registerTool: (_name: string, _cfg: unknown, h: Handler) => {
      handler = h
    },
  } as unknown as McpServer
  registerLoopTools(server, ctx)
  return async (input = {}) => JSON.parse((await (handler as Handler)(input)).content[0]!.text)
}

const baseState = (extra: Partial<SessionState> = {}): SessionState => ({
  session_id: "me",
  agent_label: "my-label",
  project_scope: null,
  pending_files: [{ path: "a.ts", tool: "Edit" }],
  last_file_report_at: 42,
  message_warned: ["w1"],
  ...extra,
})

describe("loop_tick handler", () => {
  it("no session id → no_active_session, no fetch", async () => {
    expect(await tool(null)({ start: true })).toEqual({ ok: false, reason: "no_active_session" })
    expect(calls).toEqual([])
  })

  it("start writes loop and preserves other state fields", async () => {
    writeState(HASH, baseState())
    const out = await tool()({ start: true, task: "build" })
    expect(out).toMatchObject({
      ok: true,
      session: { id: "me", label: "my-label", worktree: { is_worktree: false, path: "/repo", branch: "main", main_checkout: null } },
      verdict: { action: "reschedule", interval_minutes: 5 },
    })
    const st = readState(HASH)
    expect(st).toMatchObject({ pending_files: [{ path: "a.ts", tool: "Edit" }], last_file_report_at: 42, message_warned: ["w1"] })
    expect(st?.loop).toMatchObject({ task: "build", tier: 1 })
    // Start keeps the backend's default resolved window.
    const pending = calls.find((c) => c.method === "messagePending")
    expect(pending?.args).toEqual({ session_id: "me" })
  })

  it("cron-id-only and already-running start do not fetch", async () => {
    writeState(HASH, baseState({ loop: started() }))
    await tool()({ cron_job_id: "job-1" })
    await tool()({ start: true })
    expect(calls).toEqual([])
    expect(readState(HASH)?.loop?.cron_job_id).toBe("job-1")
  })

  it("a tick passes resolved_since = last_tick_at", async () => {
    const last = Date.UTC(2026, 9, 28, 12, 0, 0)
    writeState(HASH, baseState({ loop: { ...started(), last_tick_at: last } }))
    backendData = { ...empty(), resolved: [msg("r1")] }
    const out = await tool()({})
    expect(out).toMatchObject({ ok: true, active: true })
    const pending = calls.find((c) => c.method === "messagePending")
    expect(pending?.args).toEqual({ session_id: "me", resolved_since: new Date(last).toISOString() })
  })

  it("stop writes loop: null to disk, other fields kept", async () => {
    writeState(HASH, baseState({ loop: { ...started(), tier: 3, quiet_streak: 1, own_work_done: true } }))
    const out = await tool()({})
    expect(out).toMatchObject({ ok: true, verdict: { action: "stop" } })
    const st = readState(HASH)
    expect(st?.loop).toBeNull()
    expect(st?.message_warned).toEqual(["w1"])
  })

  it("no loop → no_loop, nothing written", async () => {
    writeState(HASH, baseState())
    expect(await tool()({})).toEqual({ ok: false, reason: "no_loop", hint: "CronDelete this job" })
    expect(calls).toEqual([])
    expect(readState(HASH)).toEqual(baseState())
  })
})

import type { ActiveSession, Decision, Handoff, Message } from "@continuity/shared"
import { describe, expect, it } from "vitest"
import type { LoopState } from "../state.js"
import { type LoopTickData, computeTick } from "./loop.js"

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

import { describe, expect, it } from "vitest"
import { LOOP_CRON_PROMPT } from "@continuity/shared"
import { type LoopLadder, cronFor, promptSyncFocus, stepLadder } from "./loop.js"

const L = (tier: 1 | 2 | 3, quiet_streak = 0, own_work_done = false): LoopLadder => ({
  tier,
  quiet_streak,
  own_work_done,
})
const quiet = { active: false, markDone: false }
const active = { active: true, markDone: false }

describe("stepLadder", () => {
  it("4 quiet ticks at tier 1 -> keep, streak 4", () => {
    let s = L(1)
    let v = stepLadder(s, quiet)
    for (let i = 0; i < 3; i++) {
      s = v.next
      v = stepLadder(s, quiet)
    }
    expect(v.next).toEqual(L(1, 4))
    expect(v.verdict.action).toBe("keep")
    expect(v.verdict.interval_minutes).toBe(5)
  })
  it("5th quiet tick at tier 1 -> reschedule to 10, streak 0", () => {
    const r = stepLadder(L(1, 4), quiet)
    expect(r.next).toEqual(L(2, 0))
    expect(r.verdict).toMatchObject({ action: "reschedule", interval_minutes: 10, cron: "*/10 * * * *" })
  })
  it("5 quiet at tier 2 -> reschedule to 30", () => {
    const r = stepLadder(L(2, 4), quiet)
    expect(r.next).toEqual(L(3, 0))
    expect(r.verdict).toMatchObject({ action: "reschedule", interval_minutes: 30 })
  })
  it("2 quiet at tier 3 -> stop", () => {
    const r1 = stepLadder(L(3), quiet)
    expect(r1.verdict.action).toBe("keep")
    const r2 = stepLadder(r1.next, quiet)
    expect(r2.verdict).toMatchObject({
      action: "stop",
      interval_minutes: 30,
      reason: "2 quiet ticks at 30 min",
    })
  })
  it("active at tier 2 (not done) -> reschedule to 5, streak 0", () => {
    const r = stepLadder(L(2, 3), active)
    expect(r.next).toEqual(L(1, 0))
    expect(r.verdict).toMatchObject({ action: "reschedule", interval_minutes: 5, cron: "*/5 * * * *" })
  })
  it("active at tier 1 -> keep, streak 0", () => {
    const r = stepLadder(L(1, 3), active)
    expect(r.next).toEqual(L(1, 0))
    expect(r.verdict.action).toBe("keep")
  })
  it("markDone at tier 1 -> reschedule to 10, own_work_done true", () => {
    const r = stepLadder(L(1, 2), { active: false, markDone: true })
    expect(r.next).toEqual(L(2, 0, true))
    expect(r.verdict).toMatchObject({ action: "reschedule", interval_minutes: 10 })
  })
  it("markDone at tier 3 -> keep, tier 3, streak unchanged", () => {
    const r = stepLadder(L(3, 1), { active: false, markDone: true })
    expect(r.next).toEqual(L(3, 1, true))
    expect(r.verdict.action).toBe("keep")
  })
  it("done + active at tier 3 -> keep tier 3, streak 0", () => {
    const r = stepLadder(L(3, 1, true), active)
    expect(r.next).toEqual(L(3, 0, true))
    expect(r.verdict.action).toBe("keep")
  })
  it("done + active at tier 2 -> keep tier 2, streak 0", () => {
    const r = stepLadder(L(2, 3, true), active)
    expect(r.next).toEqual(L(2, 0, true))
    expect(r.verdict.action).toBe("keep")
  })
  it("markDone is ignored when already done (handled as a quiet tick)", () => {
    const r = stepLadder(L(2, 1, true), { active: false, markDone: true })
    expect(r.next).toEqual(L(2, 2, true))
    expect(r.verdict.action).toBe("keep")
  })
  it("markDone is ignored when already done (handled as an active tick)", () => {
    const r = stepLadder(L(2, 3, true), { active: true, markDone: true })
    expect(r.next).toEqual(L(2, 0, true))
    expect(r.verdict.action).toBe("keep")
  })
  it("markDone + active at tier 1 -> tier 2, streak 0, reschedule to 10", () => {
    const r = stepLadder(L(1, 3), { active: true, markDone: true })
    expect(r.next).toEqual(L(2, 0, true))
    expect(r.verdict).toMatchObject({ action: "reschedule", interval_minutes: 10 })
  })
  it("idle total = 135 min", () => {
    let s = L(1)
    let total = 0
    for (let i = 0; i < 100; i++) {
      // The tick fires after waiting the interval of the tier the cron is currently on.
      total += s.tier === 1 ? 5 : s.tier === 2 ? 10 : 30
      const r = stepLadder(s, quiet)
      s = r.next
      if (r.verdict.action === "stop") break
    }
    expect(total).toBe(135)
  })
})

describe("cronFor", () => {
  it("builds a minute-step cron", () => {
    expect(cronFor(5)).toBe("*/5 * * * *")
    expect(cronFor(10)).toBe("*/10 * * * *")
    expect(cronFor(30)).toBe("*/30 * * * *")
  })
})

describe("promptSyncFocus", () => {
  it("a loop cron tick prompt never becomes the focus", () => {
    expect(promptSyncFocus(LOOP_CRON_PROMPT)).toBe("")
    expect(promptSyncFocus(`  ${LOOP_CRON_PROMPT}`)).toBe("")
    expect(promptSyncFocus("please look at [continuity-loop] output")).toBe("")
  })

  it("an ordinary prompt is the focus, capped at 280 chars", () => {
    expect(promptSyncFocus("fix the login bug")).toBe("fix the login bug")
    expect(promptSyncFocus("x".repeat(400))).toHaveLength(280)
    expect(promptSyncFocus("   ")).toBe("")
  })
})

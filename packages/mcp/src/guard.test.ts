import { describe, expect, it } from "vitest"
import { type OthersActivityEntry, buildOthersCache, collisionDecision } from "./guard.js"

const NOW = Date.parse("2026-07-16T12:00:00.000Z")
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

function entry(overrides: Partial<OthersActivityEntry> = {}): OthersActivityEntry {
  return {
    path: "src/app.ts",
    agent_label: "alpha",
    user_name: "Ann",
    touched_at: iso(-4 * 60_000),
    session_id: "sOther",
    ...overrides,
  }
}

describe("collisionDecision", () => {
  it("does not warn when no other session touched the file", () => {
    const d = collisionDecision({ entries: [entry()], relPath: "src/other.ts", warned: [], nowMs: NOW })
    expect(d.warn).toBe(false)
  })

  it("warns when another session touched the file recently", () => {
    const d = collisionDecision({ entries: [entry()], relPath: "src/app.ts", warned: [], nowMs: NOW })
    expect(d.warn).toBe(true)
    if (d.warn) {
      expect(d.reason).toContain("alpha")
      expect(d.reason).toContain("src/app.ts")
      expect(d.warned).toContain("src/app.ts")
    }
  })

  it("does not warn when the activity is older than the window", () => {
    const stale = entry({ touched_at: iso(-45 * 60_000) })
    const d = collisionDecision({ entries: [stale], relPath: "src/app.ts", warned: [], nowMs: NOW })
    expect(d.warn).toBe(false)
  })

  it("warns only once per path (already-warned paths pass)", () => {
    const d = collisionDecision({
      entries: [entry()],
      relPath: "src/app.ts",
      warned: ["src/app.ts"],
      nowMs: NOW,
    })
    expect(d.warn).toBe(false)
  })

  it("fails open on missing or malformed inputs", () => {
    expect(collisionDecision({ entries: null, relPath: "a.ts", warned: null, nowMs: NOW }).warn).toBe(false)
    expect(
      collisionDecision({
        entries: [entry({ touched_at: "not-a-date" })],
        relPath: "src/app.ts",
        warned: [],
        nowMs: NOW,
      }).warn,
    ).toBe(false)
  })

  it("caps the warned list so the state file stays bounded", () => {
    const warned = Array.from({ length: 200 }, (_, i) => `f${i}.ts`)
    const d = collisionDecision({ entries: [entry()], relPath: "src/app.ts", warned, nowMs: NOW })
    expect(d.warn).toBe(true)
    if (d.warn) expect(d.warned.length).toBeLessThanOrEqual(100)
  })
})

describe("buildOthersCache", () => {
  const base = {
    file_path: "src/app.ts",
    tool: "Edit" as const,
    repo_full_name: "o/r",
    touched_at: iso(-1000),
    agent_session_id: "s2",
    agent_label: "alpha",
    user_name: "Ann",
  }

  it("keeps only same-repo activity, mapped to cache entries", () => {
    const cache = buildOthersCache([base, { ...base, file_path: "x.ts", repo_full_name: "other/r" }], "o/r")
    expect(cache).toHaveLength(1)
    expect(cache[0]).toEqual({
      path: "src/app.ts",
      agent_label: "alpha",
      user_name: "Ann",
      touched_at: iso(-1000),
      session_id: "s2",
    })
  })

  it("caps the cache at 100 entries", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ ...base, file_path: `f${i}.ts` }))
    expect(buildOthersCache(many, "o/r").length).toBe(100)
  })
})

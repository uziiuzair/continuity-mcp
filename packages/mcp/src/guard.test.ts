import { describe, expect, it } from "vitest"
import {
  type OthersActivityEntry,
  ackGateDecision,
  buildOthersCache,
  collisionDecision,
  collisionDecisionV2,
  parseGuardMode,
  stopGateDecision,
} from "./guard.js"

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

describe("guard v2: collision negotiation", () => {
  const contested = [entry()]
  it("mode off allows; mode warn keeps warn-once", () => {
    expect(
      collisionDecisionV2({ mode: "off", entries: contested, relPath: "src/app.ts", warned: [], collisionSent: {}, nowMs: NOW })
        .action,
    ).toBe("allow")
    const warn = collisionDecisionV2({
      mode: "warn",
      entries: contested,
      relPath: "src/app.ts",
      warned: [],
      collisionSent: {},
      nowMs: NOW,
    })
    expect(warn.action).toBe("deny")
    const again = collisionDecisionV2({
      mode: "warn",
      entries: contested,
      relPath: "src/app.ts",
      warned: ["src/app.ts"],
      collisionSent: {},
      nowMs: NOW,
    })
    expect(again.action).toBe("allow")
  })
  it("negotiate: denies with a message_send instruction until a collision message exists", () => {
    const d = collisionDecisionV2({
      mode: "negotiate",
      entries: contested,
      relPath: "src/app.ts",
      warned: [],
      collisionSent: {},
      nowMs: NOW,
    })
    expect(d.action).toBe("deny")
    if (d.action === "deny") {
      expect(d.reason).toContain("message_send")
      expect(d.reason).toContain("about_file")
      expect(d.reason).toContain("src/app.ts")
    }
  })
  it("negotiate: repeat-denies (not warn-once) while no message sent", () => {
    const d = collisionDecisionV2({
      mode: "negotiate",
      entries: contested,
      relPath: "src/app.ts",
      warned: ["src/app.ts"],
      collisionSent: {},
      nowMs: NOW,
    })
    expect(d.action).toBe("deny")
  })
  it("negotiate: pending unexpired collision message keeps denying with countdown", () => {
    const sent = { "src/app.ts": { message_id: "m1", expires_at: iso(5 * 60_000), status: "pending" } }
    const d = collisionDecisionV2({
      mode: "negotiate",
      entries: contested,
      relPath: "src/app.ts",
      warned: [],
      collisionSent: sent,
      nowMs: NOW,
    })
    expect(d.action).toBe("deny")
    if (d.action === "deny") expect(d.reason).toContain("expires")
  })
  it("negotiate: responded or expired collision message allows", () => {
    const responded = { "src/app.ts": { message_id: "m1", expires_at: iso(5 * 60_000), status: "responded" } }
    expect(
      collisionDecisionV2({
        mode: "negotiate",
        entries: contested,
        relPath: "src/app.ts",
        warned: [],
        collisionSent: responded,
        nowMs: NOW,
      }).action,
    ).toBe("allow")
    const expired = { "src/app.ts": { message_id: "m1", expires_at: iso(-1000), status: "pending" } }
    expect(
      collisionDecisionV2({
        mode: "negotiate",
        entries: contested,
        relPath: "src/app.ts",
        warned: [],
        collisionSent: expired,
        nowMs: NOW,
      }).action,
    ).toBe("allow")
  })
  it("negotiate: dismissed collision message resolves the gate (allow)", () => {
    const dismissed = { "src/app.ts": { message_id: "m1", expires_at: iso(5 * 60_000), status: "dismissed" } }
    expect(
      collisionDecisionV2({
        mode: "negotiate",
        entries: contested,
        relPath: "src/app.ts",
        warned: [],
        collisionSent: dismissed,
        nowMs: NOW,
      }).action,
    ).toBe("allow")
  })
  it("negotiate: fails open on malformed expires_at in a pending entry", () => {
    const bad = { "src/app.ts": { message_id: "m1", expires_at: "not-a-date", status: "pending" } }
    expect(
      collisionDecisionV2({
        mode: "negotiate",
        entries: contested,
        relPath: "src/app.ts",
        warned: [],
        collisionSent: bad,
        nowMs: NOW,
      }).action,
    ).toBe("allow")
  })
  it("negotiate: uncontested path allows regardless of collisionSent", () => {
    expect(
      collisionDecisionV2({
        mode: "negotiate",
        entries: contested,
        relPath: "src/other.ts",
        warned: [],
        collisionSent: {},
        nowMs: NOW,
      }).action,
    ).toBe("allow")
  })
  it("fails open on malformed inputs", () => {
    expect(
      collisionDecisionV2({ mode: "negotiate", entries: null, relPath: "src/app.ts", warned: null, collisionSent: null, nowMs: NOW })
        .action,
    ).toBe("allow")
  })
})

describe("guard v2: ack gate", () => {
  const item = {
    message_id: "m1",
    from_label: "alpha",
    from_user: "Ann",
    body: "ack me",
    kind: "decision",
    related_key: "orm",
    requires_response: true,
    expires_at: iso(5 * 60_000),
  }
  it("denies once listing unanswered required items, then passes", () => {
    const d = ackGateDecision({ pendingInbound: [item], messageWarned: [], nowMs: NOW })
    expect(d.action).toBe("deny")
    if (d.action === "deny") {
      expect(d.reason).toContain("m1")
      expect(d.reason).toContain("message_respond")
      const again = ackGateDecision({ pendingInbound: [item], messageWarned: d.warned, nowMs: NOW })
      expect(again.action).toBe("allow")
    }
  })
  it("ignores expired and non-required items", () => {
    const expired = { ...item, expires_at: iso(-1000) }
    const fyi = { ...item, message_id: "m2", requires_response: false }
    expect(ackGateDecision({ pendingInbound: [expired, fyi], messageWarned: [], nowMs: NOW }).action).toBe("allow")
  })
  it("fails open on malformed inputs", () => {
    expect(ackGateDecision({ pendingInbound: null, messageWarned: null, nowMs: NOW }).action).toBe("allow")
  })
  it("caps the warned list so the state file stays bounded", () => {
    const preWarned = Array.from({ length: 200 }, (_, i) => `w${i}`)
    const d = ackGateDecision({ pendingInbound: [item], messageWarned: preWarned, nowMs: NOW })
    expect(d.action).toBe("deny")
    if (d.action === "deny") expect(d.warned?.length).toBeLessThanOrEqual(100)
  })
})

describe("guard v2: stop gate", () => {
  const item = {
    message_id: "m1",
    from_label: "alpha",
    from_user: "Ann",
    body: "ack me",
    kind: "message",
    related_key: null,
    requires_response: true,
    expires_at: iso(5 * 60_000),
  }
  it("blocks on fresh required items, never when stop_hook_active", () => {
    const b = stopGateDecision({ pendingInbound: [item], stopHookActive: false, nowMs: NOW })
    expect(b.block).toBe(true)
    if (b.block) expect(b.reason).toContain("message_respond")
    expect(stopGateDecision({ pendingInbound: [item], stopHookActive: true, nowMs: NOW }).block).toBe(false)
    expect(
      stopGateDecision({ pendingInbound: [{ ...item, expires_at: iso(-1) }], stopHookActive: false, nowMs: NOW }).block,
    ).toBe(false)
  })
  it("mentions message_dismiss as the response-not-warranted path", () => {
    const b = stopGateDecision({ pendingInbound: [item], stopHookActive: false, nowMs: NOW })
    if (b.block) expect(b.reason).toContain("message_dismiss")
  })
  it("truncates the list at 5 items and says how many more remain", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...item, message_id: `m${i}` }))
    const b = stopGateDecision({ pendingInbound: many, stopHookActive: false, nowMs: NOW })
    expect(b.block).toBe(true)
    if (b.block) {
      expect(b.reason).toContain("m4")
      expect(b.reason).not.toContain("m5")
      expect(b.reason).toContain("and 2 more")
    }
  })
})

describe("guard v2: expiry boundary", () => {
  it("an item expiring exactly now unlocks every gate (timeout-override rule)", () => {
    const atNow = iso(0)
    const sent = { "src/app.ts": { message_id: "m1", expires_at: atNow, status: "pending" } }
    expect(
      collisionDecisionV2({
        mode: "negotiate",
        entries: [entry()],
        relPath: "src/app.ts",
        warned: [],
        collisionSent: sent,
        nowMs: NOW,
      }).action,
    ).toBe("allow")
    const msg = {
      message_id: "m1",
      from_label: "alpha",
      from_user: "Ann",
      body: "ack me",
      kind: "message",
      related_key: null,
      requires_response: true,
      expires_at: atNow,
    }
    expect(ackGateDecision({ pendingInbound: [msg], messageWarned: [], nowMs: NOW }).action).toBe("allow")
    expect(stopGateDecision({ pendingInbound: [msg], stopHookActive: false, nowMs: NOW }).block).toBe(false)
  })
})

describe("parseGuardMode", () => {
  it("maps legacy booleans and defaults to negotiate", () => {
    expect(parseGuardMode(undefined)).toBe("negotiate")
    expect(parseGuardMode("")).toBe("negotiate")
    expect(parseGuardMode("true")).toBe("negotiate")
    expect(parseGuardMode("false")).toBe("off")
    expect(parseGuardMode("0")).toBe("off")
    expect(parseGuardMode("off")).toBe("off")
    expect(parseGuardMode("warn")).toBe("warn")
    expect(parseGuardMode("Negotiate")).toBe("negotiate")
  })
})

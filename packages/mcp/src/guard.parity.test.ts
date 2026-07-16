import { describe, expect, it } from "vitest"
import {
  type CollisionSentMap,
  type GuardMode,
  type OthersActivityEntry,
  type PendingInboundEntry,
  ackGateDecision,
  collisionDecision,
  collisionDecisionV2,
  parseGuardMode,
  stopGateDecision,
} from "./guard.js"

// Parity harness: plugin/scripts/lib/guard.mjs is a hand-maintained mirror of
// this package's guard.ts (the hooks run plain ESM with no build step). Every
// case below drives BOTH implementations through identical inputs and asserts
// deep-equal outputs — reason strings byte-for-byte included — so CI fails the
// moment a guard.ts change isn't mirrored. The mirror has no type declarations;
// a computed specifier keeps tsc out of resolving it, and the cast to this
// module's own surface keeps the calls below type-checked (only mirrored
// functions are used — buildOthersCache/buildPendingInbound/
// reconcileCollisionSent are intentionally absent from the mirror).
const mirrorUrl = new URL("../../../plugin/scripts/lib/guard.mjs", import.meta.url).href
const mirror = (await import(mirrorUrl)) as typeof import("./guard.js")

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

function inbound(overrides: Partial<PendingInboundEntry> = {}): PendingInboundEntry {
  return {
    message_id: "m1",
    from_label: "alpha",
    from_user: "Ann",
    body: "ack me before you edit further",
    kind: "message",
    related_key: null,
    requires_response: true,
    expires_at: iso(5 * 60_000),
    ...overrides,
  }
}

const contested = [entry()]
const stamp = (over: Partial<CollisionSentMap[string]> = {}): CollisionSentMap => ({
  "src/app.ts": { message_id: "m1", expires_at: iso(5 * 60_000), status: "pending", ...over },
})

describe("parity: collisionDecisionV2", () => {
  type V2Args = Parameters<typeof collisionDecisionV2>[0]
  const base: V2Args = {
    mode: "negotiate",
    entries: contested,
    relPath: "src/app.ts",
    warned: [],
    collisionSent: {},
    nowMs: NOW,
  }
  const cases: Array<{ name: string; args: V2Args; action: "allow" | "deny" }> = [
    { name: "off", args: { ...base, mode: "off" }, action: "allow" },
    { name: "warn fresh", args: { ...base, mode: "warn" }, action: "deny" },
    { name: "warn already-warned", args: { ...base, mode: "warn", warned: ["src/app.ts"] }, action: "allow" },
    { name: "negotiate no-stamp", args: base, action: "deny" },
    { name: "negotiate pending-unexpired", args: { ...base, collisionSent: stamp() }, action: "deny" },
    { name: "negotiate responded", args: { ...base, collisionSent: stamp({ status: "responded" }) }, action: "allow" },
    { name: "negotiate dismissed", args: { ...base, collisionSent: stamp({ status: "dismissed" }) }, action: "allow" },
    { name: "negotiate expired", args: { ...base, collisionSent: stamp({ expires_at: iso(-1000) }) }, action: "allow" },
    {
      name: "negotiate malformed-expiry",
      args: { ...base, collisionSent: stamp({ expires_at: "not-a-date" }) },
      action: "allow",
    },
    { name: "uncontested", args: { ...base, relPath: "src/other.ts" }, action: "allow" },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const ts = collisionDecisionV2(c.args)
      expect(ts.action).toBe(c.action)
      expect(mirror.collisionDecisionV2(c.args)).toEqual(ts)
    })
  }
})

describe("parity: collisionDecision (v1)", () => {
  it("fresh contest", () => {
    const args = { entries: contested, relPath: "src/app.ts", warned: [], nowMs: NOW }
    const ts = collisionDecision(args)
    expect(ts.warn).toBe(true)
    expect(mirror.collisionDecision(args)).toEqual(ts)
  })

  it("already-warned", () => {
    const args = { entries: contested, relPath: "src/app.ts", warned: ["src/app.ts"], nowMs: NOW }
    const ts = collisionDecision(args)
    expect(ts.warn).toBe(false)
    expect(mirror.collisionDecision(args)).toEqual(ts)
  })
})

describe("parity: ackGateDecision", () => {
  it("due items (reason and warned array byte-identical)", () => {
    const args = {
      pendingInbound: [inbound(), inbound({ message_id: "m2", from_label: "beta", body: "second ask" })],
      messageWarned: ["already-warned-id"],
      nowMs: NOW,
    }
    const ts = ackGateDecision(args)
    expect(ts.action).toBe("deny")
    expect(mirror.ackGateDecision(args)).toEqual(ts)
  })

  it("expired-only", () => {
    const args = { pendingInbound: [inbound({ expires_at: iso(-1000) })], messageWarned: [], nowMs: NOW }
    const ts = ackGateDecision(args)
    expect(ts.action).toBe("allow")
    expect(mirror.ackGateDecision(args)).toEqual(ts)
  })

  it(">5 items truncates with the overflow suffix", () => {
    const args = {
      pendingInbound: Array.from({ length: 7 }, (_, i) => inbound({ message_id: `m${i}` })),
      messageWarned: [],
      nowMs: NOW,
    }
    const ts = ackGateDecision(args)
    expect(ts.action).toBe("deny")
    if (ts.action === "deny") expect(ts.reason).toContain("and 2 more")
    expect(mirror.ackGateDecision(args)).toEqual(ts)
  })
})

describe("parity: stopGateDecision", () => {
  it("blocks on fresh required items", () => {
    const args = { pendingInbound: [inbound()], stopHookActive: false, nowMs: NOW }
    const ts = stopGateDecision(args)
    expect(ts.block).toBe(true)
    expect(mirror.stopGateDecision(args)).toEqual(ts)
  })

  it("never blocks when stop_hook_active", () => {
    const args = { pendingInbound: [inbound()], stopHookActive: true, nowMs: NOW }
    const ts = stopGateDecision(args)
    expect(ts.block).toBe(false)
    expect(mirror.stopGateDecision(args)).toEqual(ts)
  })

  it("expired items never block", () => {
    const args = { pendingInbound: [inbound({ expires_at: iso(-1) })], stopHookActive: false, nowMs: NOW }
    const ts = stopGateDecision(args)
    expect(ts.block).toBe(false)
    expect(mirror.stopGateDecision(args)).toEqual(ts)
  })
})

describe("parity: parseGuardMode", () => {
  it("full mapping table", () => {
    const table: Array<[string | undefined, GuardMode]> = [
      [undefined, "negotiate"],
      ["", "negotiate"],
      ["true", "negotiate"],
      ["negotiate", "negotiate"],
      ["Negotiate", "negotiate"],
      ["garbage", "negotiate"],
      ["warn", "warn"],
      ["WARN", "warn"],
      [" warn ", "warn"],
      ["off", "off"],
      ["OFF", "off"],
      ["false", "off"],
      ["False", "off"],
      ["0", "off"],
    ]
    for (const [raw, expected] of table) {
      expect(parseGuardMode(raw)).toBe(expected)
      expect(mirror.parseGuardMode(raw)).toBe(expected)
    }
  })
})

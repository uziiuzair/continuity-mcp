import {
  SESSION_GONE_MS,
  SESSION_IDLE_MS,
  derivedStatus,
  toIso,
} from "@continuity/shared"
import { describe, expect, it } from "vitest"

describe("derivedStatus", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)

  it("is active when last seen < 5m ago", () => {
    const lastSeen = now - (SESSION_IDLE_MS - 1)
    expect(derivedStatus(lastSeen, null, now)).toBe("active")
  })

  it("is idle when last seen is between 5m and 30m ago", () => {
    expect(derivedStatus(now - SESSION_IDLE_MS, null, now)).toBe("idle")
    expect(derivedStatus(now - (SESSION_GONE_MS - 1), null, now)).toBe("idle")
  })

  it("is gone when last seen >= 30m ago", () => {
    expect(derivedStatus(now - SESSION_GONE_MS, null, now)).toBe("gone")
    expect(derivedStatus(now - (SESSION_GONE_MS + 60_000), null, now)).toBe("gone")
  })

  it("returns gone when stored status is 'gone' regardless of recency", () => {
    // Last seen just now, but explicit checkout (stored gone) wins.
    expect(derivedStatus(now, "gone", now)).toBe("gone")
  })
})

describe("toIso", () => {
  it("converts a Date to an ISO string", () => {
    const d = new Date("2026-01-01T12:00:00.000Z")
    expect(toIso(d)).toBe("2026-01-01T12:00:00.000Z")
  })

  it("passes through an ISO string unchanged", () => {
    expect(toIso("2026-01-01T12:00:00.000Z")).toBe("2026-01-01T12:00:00.000Z")
  })

  it("converts an epoch number to an ISO string", () => {
    const epoch = Date.UTC(2026, 0, 1, 12, 0, 0)
    expect(toIso(epoch)).toBe("2026-01-01T12:00:00.000Z")
  })
})

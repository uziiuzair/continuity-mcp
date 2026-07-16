import type {
  ActiveSession,
  Decision,
  Handoff,
  Message,
  RecentFileActivity,
} from "@continuity/shared"
import { describe, expect, it } from "vitest"
import { type DeltaMemory, computeDeltas } from "./deltas.js"

const NOW = Date.parse("2026-07-16T12:00:00.000Z")
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

function session(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    session_id: "s1",
    agent_label: "worker",
    user_name: "Uzi",
    project_scope: null,
    current_focus: null,
    claimed_issue_number: null,
    claimed_repo_full_name: null,
    status: "active",
    last_seen_at: iso(-30_000),
    ...overrides,
  }
}

function activity(overrides: Partial<RecentFileActivity> = {}): RecentFileActivity {
  return {
    file_path: "src/app.ts",
    tool: "Edit",
    repo_full_name: "o/r",
    touched_at: iso(-60_000),
    agent_session_id: "s2",
    agent_label: "editor",
    user_name: "Uzi",
    ...overrides,
  }
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "d1",
    decision_key: "db",
    content: "Use Postgres",
    decision_type: "architecture",
    project_scope: null,
    author_user_id: null,
    author_agent_session_id: null,
    status: "active",
    supersedes: null,
    created_at: iso(-60_000),
    ...overrides,
  }
}

function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: "h1",
    from_agent_session_id: "s1",
    to_agent_session_id: null,
    to_user_id: null,
    project_scope: null,
    context: "pick up the auth refactor",
    state: null,
    suggested_next_actions: null,
    status: "pending",
    created_at: iso(-60_000),
    accepted_at: null,
    completed_at: null,
    ...overrides,
  }
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1", from_agent_session_id: "s2", to_agent_session_id: "s1",
    repo_full_name: "o/r", kind: "message", body: "which auth lib?",
    requires_response: true, related_key: null, status: "pending",
    response: null, created_at: iso(-30_000), responded_at: null,
    expires_at: iso(8 * 60_000), from_agent_label: "alpha", from_user_name: "Ann",
    ...overrides,
  }
}

const empty = {
  active: [],
  activity: [],
  decisions: [],
  handoffs: [],
  messages: { inbound: [], resolved: [] },
  repoFullName: null,
}

describe("computeDeltas", () => {
  it("seeds silently on first run (no memory): null text, memory covers current data", () => {
    const data = {
      ...empty,
      active: [session({ session_id: "sA" })],
      activity: [activity({ touched_at: iso(-10_000) })],
      decisions: [decision({ id: "dA" })],
      handoffs: [handoff({ id: "hA" })],
    }
    const { text, memory } = computeDeltas(null, data, NOW)
    expect(text).toBeNull()
    expect(memory.known_sessions).toContain("sA")
    expect(memory.known_decisions).toContain("dA")
    expect(memory.known_handoffs).toContain("hA")
    expect(memory.activity_high_water).toBe(iso(-10_000))
  })

  it("returns null text when nothing changed since the memory", () => {
    const data = { ...empty, active: [session({ session_id: "sA" })] }
    const seeded = computeDeltas(null, data, NOW).memory
    const { text } = computeDeltas(seeded, data, NOW)
    expect(text).toBeNull()
  })

  it("announces a session it has not seen before, once", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const data = {
      ...empty,
      active: [session({ session_id: "sNew", agent_label: "alpha", user_name: "Ann" })],
    }
    const first = computeDeltas(seeded, data, NOW)
    expect(first.text).toContain("alpha (Ann)")
    const second = computeDeltas(first.memory, data, NOW)
    expect(second.text).toBeNull()
  })

  it("announces file activity newer than the high-water mark and advances it", () => {
    const base = { ...empty, activity: [activity({ touched_at: iso(-120_000) })] }
    const seeded = computeDeltas(null, base, NOW).memory
    const newer = {
      ...empty,
      activity: [activity({ file_path: "src/db.ts", touched_at: iso(-5_000) })],
    }
    const first = computeDeltas(seeded, newer, NOW)
    expect(first.text).toContain("src/db.ts")
    expect(first.memory.activity_high_water).toBe(iso(-5_000))
    const second = computeDeltas(first.memory, newer, NOW)
    expect(second.text).toBeNull()
  })

  it("flags same-repo activity for coordination", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const data = {
      ...empty,
      repoFullName: "o/r",
      activity: [activity({ repo_full_name: "o/r", touched_at: iso(-1_000) })],
    }
    const { text } = computeDeltas(seeded, data, NOW)
    expect(text).toContain("same repo")
  })

  it("announces new decisions and handoffs, once each", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const data = {
      ...empty,
      decisions: [decision({ id: "d9", decision_key: "orm", content: "Use Drizzle" })],
      handoffs: [handoff({ id: "h9", context: "finish the migration" })],
    }
    const first = computeDeltas(seeded, data, NOW)
    expect(first.text).toContain("[orm] Use Drizzle")
    expect(first.text).toContain("finish the migration")
    expect(first.text).toContain("handoff_accept(h9)")
    const second = computeDeltas(first.memory, data, NOW)
    expect(second.text).toBeNull()
  })

  it("caps remembered ids so the state file stays bounded", () => {
    const many = Array.from({ length: 80 }, (_, i) => session({ session_id: `s${i}` }))
    const { memory } = computeDeltas(null, { ...empty, active: many }, NOW)
    expect(memory.known_sessions.length).toBeLessThanOrEqual(50)
  })

  it("keeps ids it announced even when they later drop out of the fetched window", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const data = { ...empty, decisions: [decision({ id: "dX" })] }
    const first = computeDeltas(seeded, data, NOW)
    expect(first.text).not.toBeNull()
    // decision no longer in the recent window, then reappears
    const gone = computeDeltas(first.memory, empty, NOW)
    expect(gone.text).toBeNull()
    const back = computeDeltas(gone.memory, data, NOW)
    expect(back.text).toBeNull()
  })
})

describe("DeltaMemory shape", () => {
  it("round-trips through JSON (stored inside the session state file)", () => {
    const { memory } = computeDeltas(null, empty, NOW)
    const parsed = JSON.parse(JSON.stringify(memory)) as DeltaMemory
    expect(computeDeltas(parsed, empty, NOW).text).toBeNull()
  })
})

describe("computeDeltas: messages", () => {
  it("announces new inbound messages once, with respond instruction and expiry", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const data = { ...empty, messages: { inbound: [message()], resolved: [] } }
    const first = computeDeltas(seeded, data, NOW)
    expect(first.text).toContain("alpha (Ann)")
    expect(first.text).toContain('message_respond(m1, ')
    expect(first.text).toContain("response required")
    expect(first.text).toContain("8m")
    expect(computeDeltas(first.memory, data, NOW).text).toBeNull()
  })
  it("renders non-required messages without the response-required tag", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const fyi = message({ id: "m2", requires_response: false, body: "fyi: deploy done" })
    const { text } = computeDeltas(seeded, { ...empty, messages: { inbound: [fyi], resolved: [] } }, NOW)
    expect(text).toContain("fyi: deploy done")
    expect(text).not.toContain("response required")
  })
  it("labels decision-ack requests distinctly", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const ack = message({ kind: "decision", related_key: "orm", body: "Decision [orm]: use Drizzle" })
    const { text } = computeDeltas(seeded, { ...empty, messages: { inbound: [ack], resolved: [] } }, NOW)
    expect(text).toContain("requires your ack")
    expect(text).toContain("[orm]")
  })
  it("announces resolutions of my outbound once, without misattributing a name", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const resolved = message({ id: "m9", status: "responded", response: "use better-auth", responded_at: iso(-1000) })
    const data = { ...empty, messages: { inbound: [], resolved: [resolved] } }
    const first = computeDeltas(seeded, data, NOW)
    expect(first.text).toContain("Response received")
    expect(first.text).toContain("use better-auth")
    expect(first.text).not.toContain("alpha")
    expect(computeDeltas(first.memory, data, NOW).text).toBeNull()
  })
  it("marks dismissals and collision context on resolved lines", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    const dismissed = message({ id: "m10", kind: "collision", related_key: "src/db.ts", status: "dismissed", response: "mid-refactor here, hold off", responded_at: iso(-1000) })
    const { text } = computeDeltas(seeded, { ...empty, messages: { inbound: [], resolved: [dismissed] } }, NOW)
    expect(text).toContain("Your message was dismissed")
    expect(text).toContain("src/db.ts")
    expect(text).toContain("hold off")
  })
  it("seeds message ids silently on first run", () => {
    const data = { ...empty, messages: { inbound: [message({ id: "mA" })], resolved: [message({ id: "mB", status: "responded", responded_at: iso(-1000) })] } }
    const { text, memory } = computeDeltas(null, data, NOW)
    expect(text).toBeNull()
    expect(memory.known_inbound).toContain("mA")
    expect(memory.known_resolved).toContain("mB")
  })
  it("announces a new inbound message even when the stored memory predates known_inbound/known_resolved", () => {
    const seeded = computeDeltas(null, empty, NOW).memory
    // Simulate a pre-upgrade state file loaded from disk: no known_inbound/known_resolved fields.
    const { known_inbound: _known_inbound, known_resolved: _known_resolved, ...rest } = seeded
    const oldMemory = rest as DeltaMemory
    const data = { ...empty, messages: { inbound: [message()], resolved: [] } }
    expect(() => computeDeltas(oldMemory, data, NOW)).not.toThrow()
    const { text } = computeDeltas(oldMemory, data, NOW)
    expect(text).toContain('message_respond(m1, ')
  })
})

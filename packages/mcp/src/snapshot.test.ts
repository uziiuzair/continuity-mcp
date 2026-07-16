import type {
  ActiveSession,
  Decision,
  Handoff,
  Message,
  RecentFileActivity,
} from "@continuity/shared"
import { describe, expect, it } from "vitest"
import { renderSnapshot } from "./snapshot.js"

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
    last_seen_at: new Date().toISOString(),
    ...overrides,
  }
}

function activity(overrides: Partial<RecentFileActivity> = {}): RecentFileActivity {
  return {
    file_path: "src/app.ts",
    tool: "Edit",
    repo_full_name: "o/r",
    touched_at: new Date().toISOString(),
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
    created_at: new Date().toISOString(),
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
    created_at: new Date().toISOString(),
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
    response: null, created_at: new Date().toISOString(), responded_at: null,
    expires_at: new Date(Date.now() + 8 * 60_000).toISOString(), from_agent_label: "alpha", from_user_name: "Ann",
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

describe("renderSnapshot", () => {
  it("includes the 'Continuity is active' header", () => {
    const out = renderSnapshot(empty)
    expect(out).toContain("# Continuity is active for this session")
  })

  it("lists active sessions with their labels", () => {
    const out = renderSnapshot({
      ...empty,
      active: [session({ agent_label: "alpha", user_name: "Ann" })],
    })
    expect(out).toContain("- alpha (Ann)")
  })

  it("shows '- none' when there are no active sessions", () => {
    const out = renderSnapshot(empty)
    expect(out).toContain("### Other active sessions\n- none")
  })

  it("flags same-repo file overlaps with the ⚠ marker", () => {
    const out = renderSnapshot({
      ...empty,
      activity: [activity({ repo_full_name: "o/r" })],
      repoFullName: "o/r",
    })
    expect(out).toContain("⚠ same repo — coordinate before editing")
  })

  it("does not flag overlap when the repo differs", () => {
    const out = renderSnapshot({
      ...empty,
      activity: [activity({ repo_full_name: "other/repo" })],
      repoFullName: "o/r",
    })
    expect(out).not.toContain("⚠")
  })

  it("omits the decisions section when there are none", () => {
    const out = renderSnapshot(empty)
    expect(out).not.toContain("### Recent decisions")
  })

  it("includes the decisions section only when non-empty", () => {
    const out = renderSnapshot({
      ...empty,
      decisions: [decision({ decision_key: "db", content: "Use Postgres" })],
    })
    expect(out).toContain("### Recent decisions")
    expect(out).toContain("[db] Use Postgres")
  })

  it("omits the handoffs section when there are none", () => {
    const out = renderSnapshot(empty)
    expect(out).not.toContain("### Pending handoffs for you")
  })

  it("includes the handoffs section only when non-empty", () => {
    const out = renderSnapshot({
      ...empty,
      handoffs: [handoff({ id: "h9", context: "finish the migration" })],
    })
    expect(out).toContain("### Pending handoffs for you")
    expect(out).toContain("finish the migration")
    expect(out).toContain("handoff_accept(h9)")
  })

  it("omits the pending-messages section when there are none", () => {
    const out = renderSnapshot(empty)
    expect(out).not.toContain("### Pending messages for you")
  })

  it("lists pending messages with respond instructions", () => {
    const out = renderSnapshot({
      ...empty,
      messages: { inbound: [message({ id: "m1", body: "which auth lib?", requires_response: true })], resolved: [] },
    })
    expect(out).toContain("### Pending messages for you")
    expect(out).toContain("which auth lib?")
    expect(out).toContain('message_respond(m1, ')
    expect(out).toContain("[response required]")
  })
})

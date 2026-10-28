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
    worktree_path: null,
    branch: null,
    is_worktree: false,
    repo_key: null,
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

  it("does not tag messages that don't require a response", () => {
    const out = renderSnapshot({
      ...empty,
      messages: { inbound: [message({ requires_response: false, body: "fyi: deploy done" })], resolved: [] },
    })
    expect(out).toContain("fyi: deploy done")
    expect(out).not.toContain("[response required]")
  })

  it("renders decision-ack requests distinctly, matching the delta shape", () => {
    const out = renderSnapshot({
      ...empty,
      messages: {
        inbound: [message({ id: "m3", kind: "decision", related_key: "orm", body: "Decision [orm]: use Drizzle" })],
        resolved: [],
      },
    })
    expect(out).toContain("Decision [orm] requires your ack")
    expect(out).toContain('message_respond(m3, "<ack>")')
  })

  describe("worktree, same repo, loop", () => {
    const START = "- Other sessions are active in this repo: start the Continuity Loop (`continuity:loop` skill) unless one is already running."
    const loopState = (o: object = {}) =>
      ({ started_at: 1, task: null, tier: 2, quiet_streak: 3, own_work_done: false, cron_job_id: "cron-9", last_tick_at: 1,
        seen: { messages: [], responses: [], handoffs: [], decisions: [], sessions: [] }, ...o }) as never

    it("renders a worktree segment relative to the main checkout, with same repo", () => {
      const out = renderSnapshot({
        ...empty, repoKey: "k", mainCheckout: "/r/main",
        active: [session({ is_worktree: true, branch: "feat/x", worktree_path: "/r/main/.claude/worktrees/x", repo_key: "k", current_focus: "auth" })],
      })
      expect(out).toMatch(/- worker \(Uzi\) · worktree feat\/x @ \.claude\/worktrees\/x · "auth" · \d+s ago · same repo/)
    })

    it("renders an absolute path outside the main checkout and (detached) for a null branch", () => {
      const out = renderSnapshot({
        ...empty, repoKey: "k", mainCheckout: "/r/main",
        active: [session({ is_worktree: true, branch: null, worktree_path: "/elsewhere/wt", repo_key: "other" })],
      })
      expect(out).toContain("- worker (Uzi) · worktree (detached) @ /elsewhere/wt · ")
      expect(out).not.toContain("same repo\n")
      expect(out).not.toContain(START)
    })

    it("omits the worktree segment for non-worktree sessions", () => {
      const out = renderSnapshot({ ...empty, active: [session({ worktree_path: "/x", branch: "b" })] })
      expect(out).not.toContain("worktree b")
    })

    it("adds the start cue under the sessions list only for same-repo sessions with no loop", () => {
      const same = { ...empty, repoKey: "k", active: [session({ repo_key: "k" })] }
      const out = renderSnapshot(same)
      expect(out).toMatch(new RegExp(`### Other active sessions\\n- worker[^\\n]*\\n${START.replace(/[()`.]/g, "\\$&")}`))
      expect(renderSnapshot({ ...same, loop: loopState() })).not.toContain(START)
      expect(renderSnapshot({ ...empty, repoKey: "k", active: [session({ repo_key: "z" })] })).not.toContain(START)
      expect(renderSnapshot({ ...empty, repoKey: "k", active: [session({ repo_key: null })] })).not.toContain(START)
    })

    it("renders the loop section, with cron pending when no job id", () => {
      expect(renderSnapshot({ ...empty, loop: loopState() })).toContain(
        "### Continuity Loop\n- running · tier 2 (10 min) · quiet 3 · cron cron-9",
      )
      expect(renderSnapshot({ ...empty, loop: loopState({ cron_job_id: null, tier: 1 }) })).toContain(
        "- running · tier 1 (5 min) · quiet 3 · cron pending",
      )
    })

    it("is additive: with no worktree, same-repo or loop the live section is unchanged", () => {
      const out = renderSnapshot({ ...empty, repoKey: "k", active: [session({ current_focus: "auth" })] })
      const live = out.slice(out.indexOf("### Other active sessions"))
      expect(live).toMatch(/^### Other active sessions\n- worker \(Uzi\) · "auth" · \d+s ago\n\n### Files other sessions are touching \(30m\)\n- none$/)
      const intro = out.slice(0, out.indexOf("\n\n## Live snapshot"))
      expect(intro.split("\n").filter((l) => !l.includes("continuity:loop")).join("\n")).toContain(
        "- Record calls others must respect with `decision_write`",
      )
    })

    it("stays under 10,000 chars with maximal data", () => {
      const long = "x".repeat(300)
      const out = renderSnapshot({
        ...empty, repoKey: "k", mainCheckout: "/r/main", repoFullName: "o/r",
        active: Array.from({ length: 12 }, (_, i) => session({ session_id: `s${i}`, agent_label: `agent-${i}`, is_worktree: true, branch: "feat/" + "b".repeat(40), worktree_path: `/r/main/.claude/worktrees/${"w".repeat(40)}${i}`, repo_key: "k", current_focus: long })),
        activity: Array.from({ length: 20 }, (_, i) => activity({ file_path: `packages/mcp/src/deep/path/file-${i}.ts` })),
        decisions: Array.from({ length: 7 }, (_, i) => decision({ id: `d${i}`, content: long })),
        handoffs: Array.from({ length: 7 }, (_, i) => handoff({ id: `h${i}`, context: long })),
        messages: { inbound: Array.from({ length: 7 }, (_, i) => message({ id: `m${i}`, body: long })), resolved: [] },
        loop: loopState(),
      })
      expect(out.length).toBeLessThan(10_000)
    })
  })
})

import { LIVE_CLAIM_STATUSES } from "@continuity/shared"
import { beforeEach, describe, expect, it } from "vitest"
import { type LocalDb, openLocalDb } from "./db.js"
import { LocalBackend } from "./local.js"

let db: LocalDb
let backend: LocalBackend

beforeEach(() => {
  db = openLocalDb(":memory:")
  backend = new LocalBackend(db)
})

describe("presence", () => {
  it("checkin is idempotent per cwd_hash", async () => {
    const first = await backend.checkin({ agent_label: "a", cwd_hash: "deadbeef" })
    expect(first.reused).toBe(false)
    const second = await backend.checkin({ agent_label: "a2", cwd_hash: "deadbeef" })
    expect(second.reused).toBe(true)
    expect(second.session_id).toBe(first.session_id)
  })

  it("a new checkin appears in list_active with derived status", async () => {
    const { session_id } = await backend.checkin({ agent_label: "worker", cwd_hash: "c1" })
    const { sessions } = await backend.listActive({})
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.session_id).toBe(session_id)
    expect(sessions[0]?.status).toBe("active")
    expect(sessions[0]?.user_name).toBeTruthy()
  })

  it("checkout removes the session from list_active", async () => {
    const { session_id } = await backend.checkin({ agent_label: "w", cwd_hash: "c2" })
    await backend.checkout({ session_id })
    const { sessions } = await backend.listActive({})
    expect(sessions).toHaveLength(0)
  })
})

describe("task claims", () => {
  it("first claim wins; second on the same issue conflicts", async () => {
    const a = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 7 })
    expect(a.conflict).toBe(false)
    const b = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 7 })
    expect(b.conflict).toBe(true)
    if (b.conflict) expect(b.existing.issue_number).toBe(7)
  })

  it("a released claim frees the issue for a new claim", async () => {
    const a = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 8 })
    expect(a.conflict).toBe(false)
    if (a.conflict) return
    await backend.taskRelease({ claim_id: a.result.id })
    const b = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 8 })
    expect(b.conflict).toBe(false)
  })

  it("a conflict always carries a real existing claim (never null)", async () => {
    const a = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 11 })
    expect(a.conflict).toBe(false)
    const b = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 11 })
    expect(b.conflict).toBe(true)
    if (b.conflict) {
      expect(b.existing).toBeTruthy()
      expect(b.existing.repo_full_name).toBe("o/r")
      expect(b.existing.issue_number).toBe(11)
      expect(LIVE_CLAIM_STATUSES).toContain(b.existing.status)
    }
  })

  it("re-claims after the live claim is released without surfacing a vanished-claim error", async () => {
    // Exercises the retry path: the prior claim is gone (released), so the
    // partial unique index is free and the insert succeeds rather than throwing.
    const a = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 12 })
    expect(a.conflict).toBe(false)
    if (a.conflict) return
    await backend.taskRelease({ claim_id: a.result.id })
    const b = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 12 })
    expect(b.conflict).toBe(false)
  })

  it("lazy sweep auto-releases an expired live claim so it can be re-claimed", async () => {
    const a = await backend.taskClaim({ repo_full_name: "o/r", issue_number: 9 })
    expect(a.conflict).toBe(false)
    if (a.conflict) return
    // Force the claim past its expiry, then a fresh backend (unthrottled) sweeps.
    db.prepare("UPDATE task_claims SET expires_at = ? WHERE id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      a.result.id,
    )
    const fresh = new LocalBackend(db)
    const b = await fresh.taskClaim({ repo_full_name: "o/r", issue_number: 9 })
    expect(b.conflict).toBe(false)
  })
})

describe("decisions", () => {
  it("a duplicate active key conflicts and returns the existing decision", async () => {
    const a = await backend.decisionWrite({ decision_key: "db", content: "Postgres" })
    expect(a.conflict).toBe(false)
    const b = await backend.decisionWrite({ decision_key: "db", content: "MySQL" })
    expect(b.conflict).toBe(true)
    if (b.conflict) expect(b.existing.content).toBe("Postgres")
  })

  it("explicit supersede via decisionWrite flips the old row", async () => {
    const a = await backend.decisionWrite({ decision_key: "db", content: "Postgres" })
    if (a.conflict) throw new Error("unexpected conflict")
    const b = await backend.decisionWrite({
      decision_key: "db",
      content: "SQLite",
      supersedes: a.result.id,
    })
    expect(b.conflict).toBe(false)
    const current = await backend.decisionGetByKey({ key: "db" })
    expect(current.decision?.content).toBe("SQLite")
    if (!b.conflict) expect(b.result.supersedes).toBe(a.result.id)
  })

  it("decisionSupersede creates a new active decision pointing at the old", async () => {
    const a = await backend.decisionWrite({ decision_key: "x", content: "1" })
    if (a.conflict) throw new Error("unexpected conflict")
    const { decision } = await backend.decisionSupersede({
      existing_id: a.result.id,
      new_content: "2",
    })
    expect(decision.content).toBe("2")
    expect(decision.supersedes).toBe(a.result.id)
    const current = await backend.decisionGetByKey({ key: "x" })
    expect(current.decision?.content).toBe("2")
  })
})

describe("handoffs", () => {
  it("create → pending → accept → complete", async () => {
    const from = await backend.checkin({ agent_label: "from", cwd_hash: "h1" })
    const { handoff } = await backend.handoffCreate({
      from_session_id: from.session_id,
      context: "pick up the auth refactor",
    })
    expect(handoff.status).toBe("pending")

    const pending = await backend.handoffPending({})
    expect(pending.handoffs).toHaveLength(1)

    const accepted = await backend.handoffAccept({ handoff_id: handoff.id })
    expect(accepted.handoff.status).toBe("accepted")

    const completed = await backend.handoffComplete({ handoff_id: handoff.id })
    expect(completed.handoff.status).toBe("completed")

    const afterPending = await backend.handoffPending({})
    expect(afterPending.handoffs).toHaveLength(0)
  })
})

describe("file activity", () => {
  it("records and reports recent file touches from other sessions", async () => {
    const editor = await backend.checkin({ agent_label: "editor", cwd_hash: "f1" })
    await backend.fileActivity({
      session_id: editor.session_id,
      repo_full_name: "o/r",
      files: [{ path: "src/app.ts", tool: "Edit" }],
    })
    // Another session asking what's being touched (excluding itself) sees it.
    const recent = await backend.recentFileActivity({ exclude_session: "someone-else" })
    expect(recent.activity).toHaveLength(1)
    expect(recent.activity[0]?.file_path).toBe("src/app.ts")
    expect(recent.activity[0]?.agent_label).toBe("editor")
  })

  it("upserts on (session, path) so repeated edits don't duplicate rows", async () => {
    const editor = await backend.checkin({ agent_label: "editor", cwd_hash: "f2" })
    for (let i = 0; i < 3; i++) {
      await backend.fileActivity({
        session_id: editor.session_id,
        files: [{ path: "src/app.ts", tool: "Edit" }],
      })
    }
    const recent = await backend.recentFileActivity({ exclude_session: "x" })
    expect(recent.activity).toHaveLength(1)
  })
})

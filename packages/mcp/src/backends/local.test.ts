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

  it("a stale supersedes id conflicts instead of creating a duplicate active decision", async () => {
    const a = await backend.decisionWrite({ decision_key: "db", content: "v1" })
    if (a.conflict) throw new Error("unexpected conflict")
    const b = await backend.decisionWrite({ decision_key: "db", content: "v2", supersedes: a.result.id })
    expect(b.conflict).toBe(false)
    // a.result.id is now superseded — reusing it must NOT yield a second active row.
    const c = await backend.decisionWrite({ decision_key: "db", content: "v3", supersedes: a.result.id })
    expect(c.conflict).toBe(true)
    if (c.conflict) expect(c.existing.content).toBe("v2")
    const { decisions: active } = await backend.decisionRecent({})
    expect(active.filter((d) => d.decision_key === "db")).toHaveLength(1)
  })

  it("a foreign supersedes id cannot retire an unrelated decision", async () => {
    const other = await backend.decisionWrite({ decision_key: "ui", content: "React" })
    if (other.conflict) throw new Error("unexpected conflict")
    const a = await backend.decisionWrite({ decision_key: "db", content: "Postgres" })
    expect(a.conflict).toBe(false)
    // Supersede targeting a different key's decision: must conflict, and the
    // unrelated decision must survive untouched.
    const b = await backend.decisionWrite({ decision_key: "db", content: "MySQL", supersedes: other.result.id })
    expect(b.conflict).toBe(true)
    const ui = await backend.decisionGetByKey({ key: "ui" })
    expect(ui.decision?.content).toBe("React")
  })

  it("decisionSupersede of a non-active decision throws instead of duplicating the key", async () => {
    const a = await backend.decisionWrite({ decision_key: "db", content: "v1" })
    if (a.conflict) throw new Error("unexpected conflict")
    await backend.decisionSupersede({ existing_id: a.result.id, new_content: "v2" })
    await expect(
      backend.decisionSupersede({ existing_id: a.result.id, new_content: "v3" }),
    ).rejects.toThrow(/decision_conflict/)
    const current = await backend.decisionGetByKey({ key: "db" })
    expect(current.decision?.content).toBe("v2")
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

describe("messages", () => {
  it("sends a direct message with computed expiry and lists it inbound", async () => {
    const a = await backend.checkin({ agent_label: "a", cwd_hash: "msg-cwd-a1" })
    const b = await backend.checkin({ agent_label: "b", cwd_hash: "msg-cwd-b1" })
    const sent = await backend.messageSend({
      from_session: a.session_id,
      to_session: b.session_id,
      kind: "message",
      body: "which auth lib?",
      requires_response: true,
    })
    expect(sent.delivered).toBe(1)
    expect(new Date(sent.expires_at).getTime()).toBeGreaterThan(Date.now())
    const { inbound } = await backend.messagePending({ session_id: b.session_id })
    expect(inbound).toHaveLength(1)
    expect(inbound[0]?.body).toBe("which auth lib?")
    expect(inbound[0]?.requires_response).toBe(true)
    expect(inbound[0]?.from_agent_label).toBe("a")
    expect(inbound[0]?.from_user_name).toBeTruthy()
  })

  it("broadcast fans out to active sessions only, excluding the sender", async () => {
    const a = await backend.checkin({ agent_label: "a2", cwd_hash: "msg-cwd-a2" })
    const b = await backend.checkin({ agent_label: "b2", cwd_hash: "msg-cwd-b2" })
    const c = await backend.checkin({ agent_label: "c2", cwd_hash: "msg-cwd-c2" })
    await backend.checkout({ session_id: c.session_id })
    const sent = await backend.messageSend({
      from_session: a.session_id,
      broadcast: true,
      kind: "decision",
      body: "ack me",
      requires_response: true,
    })
    // b gets it; c is gone; a is the sender. (Other tests' sessions may also
    // receive broadcasts if still active — count only OUR recipients.)
    expect(sent.delivered).toBeGreaterThanOrEqual(1)
    expect((await backend.messagePending({ session_id: b.session_id })).inbound.some((m) => m.body === "ack me")).toBe(true)
    expect((await backend.messagePending({ session_id: c.session_id })).inbound).toHaveLength(0)
    expect((await backend.messagePending({ session_id: a.session_id })).inbound.some((m) => m.body === "ack me")).toBe(false)
  })

  it("throws when neither to_session nor broadcast is given", async () => {
    const a = await backend.checkin({ agent_label: "a3", cwd_hash: "msg-cwd-a3" })
    await expect(
      backend.messageSend({ from_session: a.session_id, kind: "message", body: "x" }),
    ).rejects.toThrow()
  })

  it("respond and dismiss resolve a message exactly once", async () => {
    const a = await backend.checkin({ agent_label: "a4", cwd_hash: "msg-cwd-a4" })
    const b = await backend.checkin({ agent_label: "b4", cwd_hash: "msg-cwd-b4" })
    const { message_ids } = await backend.messageSend({
      from_session: a.session_id, to_session: b.session_id, kind: "message", body: "q",
    })
    const id = message_ids[0]!
    expect((await backend.messageRespond({ message_id: id, response: "answer" })).ok).toBe(true)
    expect((await backend.messageRespond({ message_id: id, response: "again" })).ok).toBe(false)
    const { resolved } = await backend.messagePending({ session_id: a.session_id })
    expect(resolved.some((m) => m.id === id && m.status === "responded" && m.response === "answer")).toBe(true)
    // dismiss path
    const { message_ids: ids2 } = await backend.messageSend({
      from_session: a.session_id, to_session: b.session_id, kind: "message", body: "q2",
    })
    expect((await backend.messageRespond({ message_id: ids2[0]!, response: "not my lane", dismiss: true })).ok).toBe(true)
    const resolved2 = (await backend.messagePending({ session_id: a.session_id })).resolved
    expect(resolved2.some((m) => m.id === ids2[0] && m.status === "dismissed")).toBe(true)
  })

  it("expired messages drop out of pending inbound", async () => {
    const a = await backend.checkin({ agent_label: "a5", cwd_hash: "msg-cwd-a5" })
    const b = await backend.checkin({ agent_label: "b5", cwd_hash: "msg-cwd-b5" })
    await backend.messageSend({
      from_session: a.session_id, to_session: b.session_id, kind: "message",
      body: "stale", expires_in_minutes: -1,
    })
    expect((await backend.messagePending({ session_id: b.session_id })).inbound).toHaveLength(0)
  })

  it("messageList filters by direction and status", async () => {
    const a = await backend.checkin({ agent_label: "a6", cwd_hash: "msg-cwd-a6" })
    const b = await backend.checkin({ agent_label: "b6", cwd_hash: "msg-cwd-b6" })
    await backend.messageSend({ from_session: a.session_id, to_session: b.session_id, kind: "message", body: "one" })
    const out = await backend.messageList({ session_id: a.session_id, direction: "outbound" })
    expect(out.messages.some((m) => m.body === "one")).toBe(true)
    const inbNone = await backend.messageList({ session_id: a.session_id, direction: "inbound", status: "pending" })
    expect(inbNone.messages.some((m) => m.body === "one")).toBe(false)
  })
})

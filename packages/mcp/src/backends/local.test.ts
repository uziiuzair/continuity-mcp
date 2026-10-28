import { LIVE_CLAIM_STATUSES } from "@continuity/shared"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { type LocalDb, openLocalDb } from "./db.js"
import { LocalBackend } from "./local.js"

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")

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
    // b gets it; c is gone; a is the sender.
    expect(sent.delivered).toBe(1)
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

describe("worktree + repo scoping", () => {
  const wt = {
    worktree_path: "/r/.claude/worktrees/x",
    branch: "feat/x",
    is_worktree: true,
    repo_key: "repo-key-1",
  }

  it("checkin stores and returns worktree fields", async () => {
    const { session_id } = await backend.checkin({ agent_label: "a", cwd_hash: "w1", ...wt })
    const { session } = await backend.getSession(session_id)
    expect(session).toMatchObject(wt)
    const { sessions } = await backend.listActive({})
    expect(sessions[0]).toMatchObject(wt)
  })

  it("sessions without worktree fields read back as null/false", async () => {
    const { session_id } = await backend.checkin({ agent_label: "a", cwd_hash: "w0" })
    const { session } = await backend.getSession(session_id)
    expect(session).toMatchObject({ worktree_path: null, branch: null, is_worktree: false, repo_key: null })
  })

  it("re-checkin updates branch", async () => {
    const first = await backend.checkin({ agent_label: "a", cwd_hash: "w2", ...wt })
    const second = await backend.checkin({ agent_label: "a", cwd_hash: "w2", ...wt, branch: "feat/y" })
    expect(second.reused).toBe(true)
    const { session } = await backend.getSession(first.session_id)
    expect(session?.branch).toBe("feat/y")
  })

  it("heartbeat updates worktree columns only when passed", async () => {
    const { session_id } = await backend.checkin({ agent_label: "a", cwd_hash: "w3", ...wt })
    await backend.heartbeat({ session_id })
    expect((await backend.getSession(session_id)).session).toMatchObject(wt)
    await backend.heartbeat({ session_id, branch: "feat/z", is_worktree: false })
    expect((await backend.getSession(session_id)).session).toMatchObject({
      ...wt,
      branch: "feat/z",
      is_worktree: false,
    })
  })

  it("listActive same_repo_key filters", async () => {
    await backend.checkin({ agent_label: "a", cwd_hash: "r1", repo_key: "k1" })
    await backend.checkin({ agent_label: "b", cwd_hash: "r2", repo_key: "k1" })
    await backend.checkin({ agent_label: "c", cwd_hash: "r3", repo_key: "k2" })
    await backend.checkin({ agent_label: "d", cwd_hash: "r4" })
    expect((await backend.listActive({})).sessions).toHaveLength(4)
    const same = await backend.listActive({ same_repo_key: "k1" })
    expect(same.sessions.map((s) => s.agent_label).sort()).toEqual(["a", "b"])
  })

  it("listActive with an empty same_repo_key matches no sessions", async () => {
    await backend.checkin({ agent_label: "a", cwd_hash: "e1", repo_key: "k1" })
    await backend.checkin({ agent_label: "d", cwd_hash: "e2" })
    expect((await backend.listActive({ same_repo_key: "" })).sessions).toEqual([])
  })

  it("repo-scoped broadcast skips other repos", async () => {
    const me = await backend.checkin({ agent_label: "me", cwd_hash: "b0", repo_key: "k1" })
    const mate = await backend.checkin({ agent_label: "mate", cwd_hash: "b1", repo_key: "k1" })
    await backend.checkin({ agent_label: "other", cwd_hash: "b2", repo_key: "k2" })
    await backend.checkin({ agent_label: "unkeyed", cwd_hash: "b3" })
    const base = { from_session: me.session_id, broadcast: true, kind: "message" as const, body: "hi" }
    const scoped = await backend.messageSend({ ...base, scope: "repo", repo_key: "k1" })
    expect(scoped.delivered).toBe(1)
    const inbox = await backend.messageList({ session_id: mate.session_id })
    expect(inbox.messages).toHaveLength(1)
    // default scope still reaches everyone
    const all = await backend.messageSend(base)
    expect(all.delivered).toBe(3)
  })

  it("repo-scoped broadcast with missing or empty repo_key reaches no one", async () => {
    const me = await backend.checkin({ agent_label: "me", cwd_hash: "n0", repo_key: "k1" })
    await backend.checkin({ agent_label: "mate", cwd_hash: "n1", repo_key: "k1" })
    const base = { from_session: me.session_id, broadcast: true, kind: "message" as const, body: "hi", scope: "repo" as const }
    expect((await backend.messageSend(base)).delivered).toBe(0)
    expect((await backend.messageSend({ ...base, repo_key: "" })).delivered).toBe(0)
  })
})

describe("sqlite migration", () => {
  const OLD_TABLE = `CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY, agent_label TEXT NOT NULL, cwd_hash TEXT NOT NULL, project_scope TEXT,
    current_focus TEXT, claimed_issue_number INTEGER, claimed_repo_full_name TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','gone')),
    started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT)`

  it("opening a DB created by the previous DDL adds the columns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cont-mig-"))
    try {
      const path = join(dir, "old.db")
      const old = new DatabaseSync(path)
      old.exec(OLD_TABLE)
      old
        .prepare("INSERT INTO agent_sessions (id, agent_label, cwd_hash, started_at, last_seen_at) VALUES (?,?,?,?,?)")
        .run("old1", "legacy", "h", new Date().toISOString(), new Date().toISOString())
      old.close()
      const migrated = openLocalDb(path)
      const b = new LocalBackend(migrated)
      expect((await b.getSession("old1")).session).toMatchObject({ branch: null, repo_key: null, is_worktree: false })
      const { session_id } = await b.checkin({ agent_label: "n", cwd_hash: "h2", ...{ repo_key: "k", branch: "m" } })
      expect((await b.getSession(session_id)).session).toMatchObject({ repo_key: "k", branch: "m" })
      migrated.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("opening twice does not fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "cont-mig-"))
    try {
      const path = join(dir, "twice.db")
      openLocalDb(path).close()
      expect(() => openLocalDb(path).close()).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// LocalBackend — the local flavor. Implements ContinuityBackend against a shared
// SQLite file via Node's built-in node:sqlite (raw prepared statements). Two
// structural differences from the Worker:
//   - Single implicit user (no users table, no auth). Identity is fabricated.
//   - No cron: expiry happens lazily. `maybeSweep()` runs at most once a minute
//     on writes to mark gone sessions, release expired claims, and prune old
//     file activity — the janitor's job, done opportunistically.
//
// SELECTs alias snake_case columns to the camelCase field names the shared
// mappers expect, so wire output is identical to the team flavor.

import { randomUUID } from "node:crypto"
import os from "node:os"
import {
  type AuditRecentArgs,
  type CheckinArgs,
  CLAIM_TTL_MS,
  type ConflictResult,
  type ContinuityBackend,
  type ContinuityIdentity,
  type Decision,
  type DecisionGetByKeyArgs,
  type DecisionRecentArgs,
  type DecisionSupersedeArgs,
  type DecisionWriteArgs,
  DEFAULT_DECISION_RECENT_WINDOW_S,
  DEFAULT_LIST_ACTIVE_WINDOW_S,
  DEFAULT_MESSAGE_TIMEOUT_MIN,
  DEFAULT_RECENT_FILE_WINDOW_S,
  FILE_ACTIVITY_PRUNE_MS,
  FILE_TOOLS,
  type FileActivityArgs,
  type Handoff,
  type HandoffCreateArgs,
  type HandoffPendingArgs,
  type ListActiveArgs,
  type Message,
  type MessageListArgs,
  type MessageRespondArgs,
  type MessageSendArgs,
  type RecentFileActivityArgs,
  SESSION_GONE_MS,
  type TaskClaim,
  type TaskClaimArgs,
  type TaskListArgs,
  type TaskUpdateArgs,
  derivedStatus,
  nowIso,
  toActiveSession,
  toAuditEvent,
  toDecision,
  toHandoff,
  toMessage,
  toRecentFileActivity,
  toSessionDetail,
  toTaskClaim,
} from "@continuity/shared"
import type { LocalDb } from "./db.js"

const SWEEP_THROTTLE_MS = 60_000
const LIVE = "'claimed','in_progress','pr_open'"

// Column projections aliased to the camelCase shape the shared mappers consume.
const SESSION_COLS =
  "id, agent_label AS agentLabel, cwd_hash AS cwdHash, project_scope AS projectScope, current_focus AS currentFocus, claimed_issue_number AS claimedIssueNumber, claimed_repo_full_name AS claimedRepoFullName, status, started_at AS startedAt, last_seen_at AS lastSeenAt, ended_at AS endedAt"
const DECISION_COLS =
  "id, decision_key AS decisionKey, content, decision_type AS decisionType, project_scope AS projectScope, author_agent_session_id AS authorAgentSessionId, status, supersedes, created_at AS createdAt"
const CLAIM_COLS =
  "id, repo_full_name AS repoFullName, issue_number AS issueNumber, claimed_by_agent_session_id AS claimedByAgentSessionId, status, pr_number AS prNumber, notes, claimed_at AS claimedAt, last_activity_at AS lastActivityAt, expires_at AS expiresAt"
const HANDOFF_COLS =
  "id, from_agent_session_id AS fromAgentSessionId, to_agent_session_id AS toAgentSessionId, project_scope AS projectScope, context, state, suggested_next_actions AS suggestedNextActions, status, created_at AS createdAt, accepted_at AS acceptedAt, completed_at AS completedAt"
const AUDIT_COLS =
  "id, event_type AS eventType, agent_session_id AS agentSessionId, payload, created_at AS createdAt"
const MESSAGE_COLS =
  "m.id, m.from_agent_session_id AS fromAgentSessionId, m.to_agent_session_id AS toAgentSessionId, m.repo_full_name AS repoFullName, m.kind, m.body, m.requires_response AS requiresResponse, m.related_key AS relatedKey, m.status, m.response, m.created_at AS createdAt, m.responded_at AS respondedAt, m.expires_at AS expiresAt, s.agent_label AS fromAgentLabel"
const MESSAGE_JOIN = "FROM messages m LEFT JOIN agent_sessions s ON s.id = m.from_agent_session_id"

type Param = string | number | null
type Row = Record<string, any>

function isoFrom(msAgo: number, now = Date.now()): string {
  return new Date(now - msAgo).toISOString()
}

// Normalize a caller-provided `since` to the canonical 24-char `...Z` ISO form
// the stored columns use, so the lexicographic comparison is correct even for
// offset-bearing (`+02:00`) or date-only (`2026-06-01`) inputs.
function normalizeSince(since: string | undefined, defaultWindowS: number): string {
  if (since == null) return isoFrom(defaultWindowS * 1000)
  const ms = Date.parse(since)
  if (Number.isNaN(ms)) return isoFrom(defaultWindowS * 1000)
  return new Date(ms).toISOString()
}

export class LocalBackend implements ContinuityBackend {
  private readonly identity: ContinuityIdentity
  private lastSweepMs = 0

  constructor(private readonly db: LocalDb) {
    this.identity = {
      userId: "local",
      userName: os.userInfo().username || "local",
      githubUsername: null,
    }
  }

  // ---- query helpers ----

  private all(sql: string, ...params: Param[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }
  private get(sql: string, ...params: Param[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }
  private run(sql: string, ...params: Param[]): number {
    return Number(this.db.prepare(sql).run(...params).changes)
  }
  private tx<T>(fn: () => T): T {
    // IMMEDIATE acquires the write lock up front so concurrent writers from
    // parallel sessions serialize on it (governed by busy_timeout) rather than
    // failing mid-transaction with an un-retryable SQLITE_BUSY_SNAPSHOT on a
    // read→write upgrade. Matches the Worker's clean-conflict contract.
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const r = fn()
      this.db.exec("COMMIT")
      return r
    } catch (e) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // ignore
      }
      throw e
    }
  }

  // ---- Presence ----

  async checkin(args: CheckinArgs): Promise<{ session_id: string; reused: boolean }> {
    this.maybeSweep()
    const now = nowIso()
    const result = this.tx(() => {
      const existing = this.get(
        "SELECT id FROM agent_sessions WHERE cwd_hash = ? AND status <> 'gone' LIMIT 1",
        args.cwd_hash,
      )
      if (existing) {
        this.run(
          "UPDATE agent_sessions SET agent_label=?, project_scope=?, current_focus=?, status='active', last_seen_at=?, ended_at=NULL WHERE id=?",
          args.agent_label,
          args.project_scope ?? null,
          args.current_focus ?? null,
          now,
          existing.id,
        )
        return { session_id: existing.id as string, reused: true }
      }
      const id = randomUUID()
      const changes = this.run(
        "INSERT INTO agent_sessions (id, agent_label, cwd_hash, project_scope, current_focus, status, started_at, last_seen_at) VALUES (?,?,?,?,?,'active',?,?) ON CONFLICT DO NOTHING",
        id,
        args.agent_label,
        args.cwd_hash,
        args.project_scope ?? null,
        args.current_focus ?? null,
        now,
        now,
      )
      if (changes > 0) return { session_id: id, reused: false }
      // Lost a cross-process race between the select and the insert.
      const live = this.get(
        "SELECT id FROM agent_sessions WHERE cwd_hash = ? AND status <> 'gone' LIMIT 1",
        args.cwd_hash,
      )
      return { session_id: (live?.id as string) ?? id, reused: true }
    })
    if (!result.reused) this.audit("agent.checkin", result.session_id, { cwd_hash: args.cwd_hash })
    return result
  }

  async heartbeat(args: { session_id: string; current_focus?: string }): Promise<void> {
    this.maybeSweep()
    const changes =
      typeof args.current_focus === "string"
        ? this.run(
            "UPDATE agent_sessions SET last_seen_at=?, status='active', current_focus=? WHERE id=?",
            nowIso(),
            args.current_focus,
            args.session_id,
          )
        : this.run(
            "UPDATE agent_sessions SET last_seen_at=?, status='active' WHERE id=?",
            nowIso(),
            args.session_id,
          )
    if (changes === 0) throw new Error("not_found")
  }

  async checkout(args: { session_id: string; reason?: string }): Promise<void> {
    const now = nowIso()
    const changes = this.run(
      "UPDATE agent_sessions SET status='gone', ended_at=?, last_seen_at=? WHERE id=?",
      now,
      now,
      args.session_id,
    )
    if (changes === 0) throw new Error("not_found")
    this.audit("agent.checkout", args.session_id, { reason: args.reason ?? null })
  }

  async listActive(args: ListActiveArgs) {
    this.maybeSweep()
    const windowS =
      args.max_age_seconds && args.max_age_seconds > 0 ? args.max_age_seconds : DEFAULT_LIST_ACTIVE_WINDOW_S
    const where = ["status <> 'gone'", "last_seen_at > ?"]
    const params: Param[] = [isoFrom(windowS * 1000)]
    if (args.project_scope) {
      where.push("project_scope = ?")
      params.push(args.project_scope)
    }
    if (args.exclude_session) {
      where.push("id <> ?")
      params.push(args.exclude_session)
    }
    const rows = this.all(
      `SELECT ${SESSION_COLS} FROM agent_sessions WHERE ${where.join(" AND ")} ORDER BY last_seen_at DESC`,
      ...params,
    )
    const sessions = rows
      .map((r) => ({ r, status: derivedStatus(r.lastSeenAt, r.status) }))
      .filter((x) => x.status !== "gone")
      .map((x) => toActiveSession({ ...x.r, status: x.status } as never, this.identity.userName))
    return { sessions }
  }

  async getSession(id: string) {
    const r = this.get(`SELECT ${SESSION_COLS} FROM agent_sessions WHERE id = ? LIMIT 1`, id)
    if (!r) return { session: null }
    return { session: toSessionDetail({ ...r, status: derivedStatus(r.lastSeenAt, r.status) } as never) }
  }

  async fileActivity(args: FileActivityArgs) {
    const owner = this.get("SELECT id FROM agent_sessions WHERE id = ? LIMIT 1", args.session_id)
    if (!owner) throw new Error("not_found")
    const now = nowIso()
    const valid = args.files.filter((f) => f.path && FILE_TOOLS.includes(f.tool))
    if (valid.length === 0) return { ok: true, count: 0 }
    this.tx(() => {
      for (const f of valid) {
        this.run(
          "INSERT INTO file_activity (id, agent_session_id, file_path, repo_full_name, tool, touched_at) VALUES (?,?,?,?,?,?) " +
            "ON CONFLICT(agent_session_id, file_path) DO UPDATE SET tool=excluded.tool, repo_full_name=excluded.repo_full_name, touched_at=excluded.touched_at",
          randomUUID(),
          args.session_id,
          f.path,
          args.repo_full_name ?? null,
          f.tool,
          now,
        )
      }
    })
    return { ok: true, count: valid.length }
  }

  async recentFileActivity(args: RecentFileActivityArgs) {
    const windowS =
      args.since_seconds && args.since_seconds > 0 ? args.since_seconds : DEFAULT_RECENT_FILE_WINDOW_S
    const limit = Math.min(args.limit && args.limit > 0 ? args.limit : 50, 200)
    const where = ["fa.touched_at > ?"]
    const params: Param[] = [isoFrom(windowS * 1000)]
    if (args.exclude_session) {
      where.push("fa.agent_session_id <> ?")
      params.push(args.exclude_session)
    }
    if (args.path_prefix) {
      where.push("fa.file_path LIKE ?")
      params.push(`${args.path_prefix}%`)
    }
    const rows = this.all(
      `SELECT fa.file_path AS filePath, fa.tool AS tool, fa.repo_full_name AS repoFullName, fa.touched_at AS touchedAt, fa.agent_session_id AS agentSessionId, s.agent_label AS agentLabel ` +
        `FROM file_activity fa JOIN agent_sessions s ON s.id = fa.agent_session_id WHERE ${where.join(" AND ")} ORDER BY fa.touched_at DESC LIMIT ?`,
      ...params,
      limit,
    )
    const activity = rows.map((r) =>
      toRecentFileActivity(r as never, { agentLabel: r.agentLabel, userName: this.identity.userName }),
    )
    return { activity }
  }

  async auditEvent(args: { event_type: string; session_id?: string; payload?: unknown }) {
    this.audit(args.event_type, args.session_id ?? null, args.payload)
  }

  // ---- Decisions ----

  async decisionWrite(args: DecisionWriteArgs): Promise<ConflictResult<Decision>> {
    this.maybeSweep()
    const now = nowIso()
    const res: ConflictResult<Decision> = this.tx(() => {
      const existingActive = this.get(
        `SELECT ${DECISION_COLS} FROM decisions WHERE decision_key=? AND status='active' ORDER BY created_at DESC LIMIT 1`,
        args.decision_key,
      )
      if (existingActive && !args.supersedes) {
        return { conflict: true, existing: toDecision(existingActive as never) }
      }
      if (args.supersedes) {
        // Key-scoped on purpose: a stale or foreign `supersedes` id must not
        // retire an unrelated decision. If it matches nothing, the insert below
        // hits decisions_active_key_uq and we report the conflict.
        this.run(
          "UPDATE decisions SET status='superseded' WHERE id=? AND decision_key=?",
          args.supersedes,
          args.decision_key,
        )
      }
      const id = randomUUID()
      const changes = this.run(
        "INSERT INTO decisions (id, decision_key, content, decision_type, project_scope, author_agent_session_id, status, supersedes, created_at) VALUES (?,?,?,?,?,?,'active',?,?) ON CONFLICT DO NOTHING",
        id,
        args.decision_key,
        args.content,
        args.decision_type ?? "other",
        args.project_scope ?? null,
        args.author_agent_session_id ?? null,
        args.supersedes ?? null,
        now,
      )
      if (changes === 0) {
        const blocking = this.get(
          `SELECT ${DECISION_COLS} FROM decisions WHERE decision_key=? AND status='active' ORDER BY created_at DESC LIMIT 1`,
          args.decision_key,
        )
        if (!blocking) throw new Error("decision_write_conflict")
        return { conflict: true, existing: toDecision(blocking as never) }
      }
      const row = this.get(`SELECT ${DECISION_COLS} FROM decisions WHERE id=?`, id)
      return { conflict: false, result: toDecision(row as never) }
    })
    if (!res.conflict) {
      this.audit(args.supersedes ? "decision.supersede" : "decision.write", args.author_agent_session_id ?? null, {
        decision_key: args.decision_key,
        supersedes: args.supersedes ?? null,
      })
    }
    return res
  }

  async decisionRecent(args: DecisionRecentArgs) {
    const since = normalizeSince(args.since, DEFAULT_DECISION_RECENT_WINDOW_S)
    const limit = Math.min(args.limit && args.limit > 0 ? args.limit : 25, 100)
    const where = ["created_at > ?", "status='active'"]
    const params: Param[] = [since]
    if (args.scope) {
      where.push("project_scope=?")
      params.push(args.scope)
    }
    const rows = this.all(
      `SELECT ${DECISION_COLS} FROM decisions WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      ...params,
      limit,
    )
    return { decisions: rows.map((r) => toDecision(r as never)) }
  }

  async decisionGetByKey(args: DecisionGetByKeyArgs) {
    const where = ["decision_key=?", "status='active'"]
    const params: Param[] = [args.key]
    if (args.scope) {
      where.push("project_scope=?")
      params.push(args.scope)
    }
    const r = this.get(
      `SELECT ${DECISION_COLS} FROM decisions WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 1`,
      ...params,
    )
    return { decision: r ? toDecision(r as never) : null }
  }

  async decisionSupersede(args: DecisionSupersedeArgs) {
    const now = nowIso()
    const decision = this.tx(() => {
      const old = this.get(`SELECT ${DECISION_COLS} FROM decisions WHERE id=? LIMIT 1`, args.existing_id)
      if (!old) throw new Error("not_found")
      this.run("UPDATE decisions SET status='superseded' WHERE id=?", old.id)
      const id = randomUUID()
      const changes = this.run(
        "INSERT INTO decisions (id, decision_key, content, decision_type, project_scope, author_agent_session_id, status, supersedes, created_at) VALUES (?,?,?,?,?,?,'active',?,?) ON CONFLICT DO NOTHING",
        id,
        old.decisionKey,
        args.new_content,
        old.decisionType,
        old.projectScope ?? null,
        args.author_agent_session_id ?? null,
        old.id,
        now,
      )
      // Blocked by decisions_active_key_uq: `existing_id` wasn't the active
      // decision for its key, so superseding it can't replace the real one.
      if (changes === 0) throw new Error("decision_conflict: another active decision exists for this key")
      return toDecision(this.get(`SELECT ${DECISION_COLS} FROM decisions WHERE id=?`, id) as never)
    })
    this.audit("decision.supersede", args.author_agent_session_id ?? null, {
      decision_key: decision.decision_key,
      existing_id: args.existing_id,
      reason: args.reason ?? null,
    })
    return { decision }
  }

  // ---- Task claims ----

  async taskClaim(args: TaskClaimArgs): Promise<ConflictResult<TaskClaim>> {
    this.maybeSweep()
    const res: ConflictResult<TaskClaim> = this.tx(() => {
      // Bounded retry: if the insert is blocked but the conflicting live claim
      // has vanished (released/expired) by the time we re-select, try again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const now = nowIso()
        const id = randomUUID()
        const changes = this.run(
          "INSERT INTO task_claims (id, repo_full_name, issue_number, claimed_by_agent_session_id, status, notes, claimed_at, last_activity_at, expires_at) VALUES (?,?,?,?,'claimed',?,?,?,?) ON CONFLICT DO NOTHING",
          id,
          args.repo_full_name,
          args.issue_number,
          args.agent_session_id ?? null,
          args.notes ?? null,
          now,
          now,
          new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
        )
        if (changes > 0) {
          const row = this.get(`SELECT ${CLAIM_COLS} FROM task_claims WHERE id=?`, id)
          return { conflict: false, result: toTaskClaim(row as never) }
        }
        const current = this.get(
          `SELECT ${CLAIM_COLS} FROM task_claims WHERE repo_full_name=? AND issue_number=? AND status IN (${LIVE}) LIMIT 1`,
          args.repo_full_name,
          args.issue_number,
        )
        if (current) return { conflict: true, existing: toTaskClaim(current as never) }
      }
      throw new Error("claim_conflict_without_live_claim")
    })
    if (!res.conflict) {
      this.audit("task.claim", args.agent_session_id ?? null, {
        repo_full_name: args.repo_full_name,
        issue_number: args.issue_number,
      })
    }
    return res
  }

  async taskUpdate(args: TaskUpdateArgs) {
    const sets = ["last_activity_at=?"]
    const params: Param[] = [nowIso()]
    if (args.status) {
      sets.push("status=?")
      params.push(args.status)
    }
    if (Number.isInteger(args.pr_number)) {
      sets.push("pr_number=?")
      params.push(args.pr_number as number)
    }
    if (typeof args.notes === "string") {
      sets.push("notes=?")
      params.push(args.notes)
    }
    const changes = this.run(
      `UPDATE task_claims SET ${sets.join(", ")} WHERE id=?`,
      ...params,
      args.claim_id,
    )
    if (changes === 0) throw new Error("not_found")
    return { claim: toTaskClaim(this.get(`SELECT ${CLAIM_COLS} FROM task_claims WHERE id=?`, args.claim_id) as never) }
  }

  async taskRelease(args: { claim_id: string; reason?: string }) {
    const changes = this.run(
      "UPDATE task_claims SET status='released', last_activity_at=? WHERE id=?",
      nowIso(),
      args.claim_id,
    )
    if (changes === 0) throw new Error("not_found")
    this.audit("task.release", null, { claim_id: args.claim_id, reason: args.reason ?? null })
    return { claim: toTaskClaim(this.get(`SELECT ${CLAIM_COLS} FROM task_claims WHERE id=?`, args.claim_id) as never) }
  }

  async taskComplete(args: { claim_id: string; outcome?: string }) {
    const changes = this.run(
      "UPDATE task_claims SET status='completed', last_activity_at=? WHERE id=?",
      nowIso(),
      args.claim_id,
    )
    if (changes === 0) throw new Error("not_found")
    this.audit("task.complete", null, { claim_id: args.claim_id, outcome: args.outcome ?? null })
    return { claim: toTaskClaim(this.get(`SELECT ${CLAIM_COLS} FROM task_claims WHERE id=?`, args.claim_id) as never) }
  }

  async taskList(args: TaskListArgs) {
    const limit = Math.min(args.limit && args.limit > 0 ? args.limit : 50, 200)
    const where: string[] = []
    const params: Param[] = []
    if (args.status) {
      where.push("tc.status=?")
      params.push(args.status)
    } else {
      where.push(`tc.status IN (${LIVE})`)
    }
    if (args.scope) {
      where.push("tc.repo_full_name=?")
      params.push(args.scope)
    }
    const rows = this.all(
      `SELECT tc.id, tc.repo_full_name AS repoFullName, tc.issue_number AS issueNumber, tc.claimed_by_agent_session_id AS claimedByAgentSessionId, tc.status, tc.pr_number AS prNumber, tc.notes, tc.claimed_at AS claimedAt, tc.last_activity_at AS lastActivityAt, tc.expires_at AS expiresAt, s.agent_label AS agentLabel ` +
        `FROM task_claims tc LEFT JOIN agent_sessions s ON s.id = tc.claimed_by_agent_session_id WHERE ${where.join(" AND ")} ORDER BY tc.last_activity_at DESC LIMIT ?`,
      ...params,
      limit,
    )
    const claims = rows.map((r) =>
      toTaskClaim(r as never, { userName: this.identity.userName, agentLabel: (r.agentLabel ?? null) as string | null }),
    )
    return { claims }
  }

  // ---- Handoffs ----

  async handoffCreate(args: HandoffCreateArgs) {
    const id = randomUUID()
    this.run(
      "INSERT INTO handoffs (id, from_agent_session_id, to_agent_session_id, project_scope, context, state, suggested_next_actions, status, created_at) VALUES (?,?,?,?,?,?,?,'pending',?)",
      id,
      args.from_session_id,
      args.to_session_id ?? null,
      args.project_scope ?? null,
      args.context,
      args.state ?? null,
      args.suggested_next_actions ?? null,
      nowIso(),
    )
    const handoff = toHandoff(this.get(`SELECT ${HANDOFF_COLS} FROM handoffs WHERE id=?`, id) as never)
    this.audit("handoff.create", args.from_session_id, { to_session_id: handoff.to_agent_session_id })
    return { handoff }
  }

  async handoffPending(args: HandoffPendingArgs) {
    const includeBroadcast = args.include_broadcast !== false
    const targets: string[] = []
    const params: Param[] = []
    if (args.agent_session_id) {
      targets.push("to_agent_session_id = ?")
      params.push(args.agent_session_id)
    }
    if (includeBroadcast || targets.length === 0) targets.push("to_agent_session_id IS NULL")
    const where = ["status='pending'", `(${targets.join(" OR ")})`]
    if (args.project_scope) {
      where.push("project_scope=?")
      params.push(args.project_scope)
    }
    const rows = this.all(
      `SELECT ${HANDOFF_COLS} FROM handoffs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 50`,
      ...params,
    )
    return { handoffs: rows.map((r) => toHandoff(r as never)) }
  }

  async handoffAccept(args: { handoff_id: string; agent_session_id?: string }) {
    const now = nowIso()
    const changes =
      typeof args.agent_session_id === "string"
        ? this.run(
            "UPDATE handoffs SET status='accepted', accepted_at=?, to_agent_session_id=? WHERE id=? AND status='pending'",
            now,
            args.agent_session_id,
            args.handoff_id,
          )
        : this.run(
            "UPDATE handoffs SET status='accepted', accepted_at=? WHERE id=? AND status='pending'",
            now,
            args.handoff_id,
          )
    if (changes === 0) throw new Error("not_found_or_not_pending")
    this.audit("handoff.accept", args.agent_session_id ?? null, { handoff_id: args.handoff_id })
    return { handoff: toHandoff(this.get(`SELECT ${HANDOFF_COLS} FROM handoffs WHERE id=?`, args.handoff_id) as never) }
  }

  async handoffComplete(args: { handoff_id: string; outcome?: string }) {
    const changes = this.run(
      "UPDATE handoffs SET status='completed', completed_at=? WHERE id=?",
      nowIso(),
      args.handoff_id,
    )
    if (changes === 0) throw new Error("not_found")
    this.audit("handoff.complete", null, { handoff_id: args.handoff_id, outcome: args.outcome ?? null })
    return { handoff: toHandoff(this.get(`SELECT ${HANDOFF_COLS} FROM handoffs WHERE id=?`, args.handoff_id) as never) }
  }

  // ---- Messages ----

  async messageSend(args: MessageSendArgs): Promise<{ message_ids: string[]; delivered: number; expires_at: string }> {
    this.maybeSweep()
    if (!args.to_session && !args.broadcast) throw new Error("to_session or broadcast required")
    const now = Date.now()
    const timeoutMin = args.expires_in_minutes ?? DEFAULT_MESSAGE_TIMEOUT_MIN
    const expiresAt = new Date(now + timeoutMin * 60_000).toISOString()
    const recipients = args.broadcast
      ? this.all(
          "SELECT id FROM agent_sessions WHERE status <> 'gone' AND last_seen_at >= ? AND id <> ?",
          isoFrom(DEFAULT_LIST_ACTIVE_WINDOW_S * 1000, now),
          args.from_session,
        ).map((r) => r.id as string)
      : [args.to_session as string]
    const ids: string[] = []
    this.tx(() => {
      for (const to of recipients) {
        const id = randomUUID()
        ids.push(id)
        this.run(
          `INSERT INTO messages (id, from_agent_session_id, to_agent_session_id, repo_full_name, kind, body, requires_response, related_key, status, created_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`,
          id,
          args.from_session,
          to,
          args.repo_full_name ?? null,
          args.kind,
          args.body,
          args.requires_response ? 1 : 0,
          args.related_key ?? null,
          nowIso(),
          expiresAt,
        )
      }
    })
    return { message_ids: ids, delivered: ids.length, expires_at: expiresAt }
  }

  async messageRespond(args: MessageRespondArgs): Promise<{ ok: boolean }> {
    const changes = this.run(
      "UPDATE messages SET status = ?, response = ?, responded_at = ? WHERE id = ? AND status = 'pending'",
      args.dismiss ? "dismissed" : "responded",
      args.response,
      nowIso(),
      args.message_id,
    )
    return { ok: changes > 0 }
  }

  async messageList(args: MessageListArgs): Promise<{ messages: Message[] }> {
    const dirSql =
      args.direction === "outbound"
        ? "m.from_agent_session_id = ?"
        : args.direction === "inbound"
          ? "m.to_agent_session_id = ?"
          : "(m.from_agent_session_id = ? OR m.to_agent_session_id = ?)"
    const dirParams: Param[] = args.direction ? [args.session_id] : [args.session_id, args.session_id]
    const statusSql = args.status ? " AND m.status = ?" : ""
    const params: Param[] = args.status ? [...dirParams, args.status] : dirParams
    const rows = this.all(
      `SELECT ${MESSAGE_COLS} ${MESSAGE_JOIN} WHERE ${dirSql}${statusSql} ORDER BY m.created_at DESC LIMIT ?`,
      ...params,
      Math.min(args.limit ?? 50, 200),
    )
    return { messages: rows.map((r) => toMessage(this.withFromUserName(r) as never)) }
  }

  async messagePending(args: { session_id: string }): Promise<{ inbound: Message[]; resolved: Message[] }> {
    const now = nowIso()
    const inbound = this.all(
      `SELECT ${MESSAGE_COLS} ${MESSAGE_JOIN}
       WHERE m.to_agent_session_id = ? AND m.status = 'pending' AND m.expires_at > ?
       ORDER BY m.created_at ASC LIMIT 20`,
      args.session_id,
      now,
    )
    const resolved = this.all(
      `SELECT ${MESSAGE_COLS} ${MESSAGE_JOIN}
       WHERE m.from_agent_session_id = ? AND m.status <> 'pending' AND m.responded_at > ?
       ORDER BY m.responded_at ASC LIMIT 20`,
      args.session_id,
      isoFrom(30 * 60_000),
    )
    return {
      inbound: inbound.map((r) => toMessage(this.withFromUserName(r) as never)),
      resolved: resolved.map((r) => toMessage(this.withFromUserName(r) as never)),
    }
  }

  // Local flavor has a single implicit user; stamp its name for display parity
  // with the team flavor's join.
  private withFromUserName(r: Row): Row {
    return { ...r, fromUserName: this.identity.userName }
  }

  // ---- Audit ----

  async auditRecent(args: AuditRecentArgs) {
    const since = normalizeSince(args.since, DEFAULT_DECISION_RECENT_WINDOW_S)
    const limit = Math.min(args.limit && args.limit > 0 ? args.limit : 50, 200)
    const where = ["created_at > ?"]
    const params: Param[] = [since]
    if (args.type) {
      where.push("event_type=?")
      params.push(args.type)
    }
    const rows = this.all(
      `SELECT ${AUDIT_COLS} FROM audit_events WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      ...params,
      limit,
    )
    return { events: rows.map((r) => toAuditEvent(r as never)) }
  }

  // ---- Internal ----

  private audit(eventType: string, sessionId: string | null, payload: unknown): void {
    try {
      this.run(
        "INSERT INTO audit_events (id, event_type, agent_session_id, payload, created_at) VALUES (?,?,?,?,?)",
        randomUUID(),
        eventType,
        sessionId,
        payload != null ? JSON.stringify(payload) : null,
        nowIso(),
      )
    } catch {
      // Audit is best-effort; never fail the action it records.
    }
  }

  private maybeSweep(): void {
    const now = Date.now()
    if (now - this.lastSweepMs < SWEEP_THROTTLE_MS) return
    this.lastSweepMs = now
    const nowS = new Date(now).toISOString()
    this.run(
      "UPDATE agent_sessions SET status='gone', ended_at=? WHERE status <> 'gone' AND last_seen_at < ?",
      nowS,
      isoFrom(SESSION_GONE_MS, now),
    )
    this.run(
      `UPDATE task_claims SET status='released', last_activity_at=? WHERE status IN (${LIVE}) AND expires_at < ?`,
      nowS,
      nowS,
    )
    this.run("DELETE FROM file_activity WHERE touched_at < ?", isoFrom(FILE_ACTIVITY_PRUNE_MS, now))
  }
}

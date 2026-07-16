// SQLite schema for the LOCAL flavor (single machine, parallel sessions).
//
// Mirrors schema.pg.ts with three differences driven by the local model:
//   1. uuid → text  (ids generated with crypto.randomUUID() in the backend)
//   2. timestamptz → text  (ISO-8601 strings; sort = chronological order)
//   3. no `users` table and no user FK columns — local is a single implicit
//      user — and no `project_state_cache` (GitHub is team-flavor only).
//
// Tables are created at runtime from SQLITE_DDL below (no drizzle-kit / no
// migration step) so local mode is genuinely zero-config. The drizzle table
// objects here are used only for type-safe query building; the partial UNIQUE
// indexes and CHECK constraints that enforce correctness live in the DDL.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { MESSAGE_KINDS, MESSAGE_STATUSES } from "./constants.js"

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    agentLabel: text("agent_label").notNull(),
    cwdHash: text("cwd_hash").notNull(),
    projectScope: text("project_scope"),
    currentFocus: text("current_focus"),
    claimedIssueNumber: integer("claimed_issue_number"),
    claimedRepoFullName: text("claimed_repo_full_name"),
    status: text("status", { enum: ["active", "idle", "gone"] })
      .notNull()
      .default("active"),
    startedAt: text("started_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => [
    index("agent_sessions_last_seen_idx").on(t.lastSeenAt),
    index("agent_sessions_status_idx").on(t.status),
  ],
)

export const fileActivity = sqliteTable(
  "file_activity",
  {
    id: text("id").primaryKey(),
    agentSessionId: text("agent_session_id").notNull(),
    filePath: text("file_path").notNull(),
    repoFullName: text("repo_full_name"),
    tool: text("tool", { enum: ["Write", "Edit", "MultiEdit", "NotebookEdit"] }).notNull(),
    touchedAt: text("touched_at").notNull(),
  },
  (t) => [
    index("file_activity_touched_at_idx").on(t.touchedAt),
    index("file_activity_session_idx").on(t.agentSessionId),
  ],
)

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    agentSessionId: text("agent_session_id"),
    payload: text("payload"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("audit_events_type_idx").on(t.eventType),
    index("audit_events_created_at_idx").on(t.createdAt),
  ],
)

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    decisionKey: text("decision_key").notNull(),
    content: text("content").notNull(),
    decisionType: text("decision_type", {
      enum: ["architecture", "tooling", "process", "scope", "other"],
    })
      .notNull()
      .default("other"),
    projectScope: text("project_scope"),
    authorAgentSessionId: text("author_agent_session_id"),
    status: text("status", { enum: ["active", "pending", "superseded", "rejected"] })
      .notNull()
      .default("active"),
    supersedes: text("supersedes"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("decisions_key_idx").on(t.decisionKey),
    index("decisions_status_idx").on(t.status),
    index("decisions_created_at_idx").on(t.createdAt),
  ],
)

export const taskClaims = sqliteTable(
  "task_claims",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    claimedByAgentSessionId: text("claimed_by_agent_session_id"),
    status: text("status", {
      enum: ["claimed", "in_progress", "pr_open", "released", "completed"],
    })
      .notNull()
      .default("claimed"),
    prNumber: integer("pr_number"),
    notes: text("notes"),
    claimedAt: text("claimed_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    index("task_claims_repo_issue_idx").on(t.repoFullName, t.issueNumber),
    index("task_claims_status_idx").on(t.status),
    index("task_claims_expires_idx").on(t.expiresAt),
  ],
)

export const handoffs = sqliteTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    fromAgentSessionId: text("from_agent_session_id").notNull(),
    toAgentSessionId: text("to_agent_session_id"),
    projectScope: text("project_scope"),
    context: text("context").notNull(),
    state: text("state"),
    suggestedNextActions: text("suggested_next_actions"),
    status: text("status", { enum: ["pending", "accepted", "completed", "expired"] })
      .notNull()
      .default("pending"),
    createdAt: text("created_at").notNull(),
    acceptedAt: text("accepted_at"),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("handoffs_status_idx").on(t.status),
    index("handoffs_to_agent_idx").on(t.toAgentSessionId),
  ],
)

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    fromAgentSessionId: text("from_agent_session_id").notNull(),
    toAgentSessionId: text("to_agent_session_id").notNull(),
    repoFullName: text("repo_full_name"),
    kind: text("kind", { enum: [...MESSAGE_KINDS] }).notNull(),
    body: text("body").notNull(),
    requiresResponse: integer("requires_response").notNull().default(0),
    relatedKey: text("related_key"),
    status: text("status", { enum: [...MESSAGE_STATUSES] })
      .notNull()
      .default("pending"),
    response: text("response"),
    createdAt: text("created_at").notNull(),
    respondedAt: text("responded_at"),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    index("messages_to_status_idx").on(t.toAgentSessionId, t.status),
    index("messages_from_status_idx").on(t.fromAgentSessionId, t.status),
    index("messages_expires_idx").on(t.expiresAt),
  ],
)

export type AgentSessionRow = typeof agentSessions.$inferSelect
export type FileActivityRow = typeof fileActivity.$inferSelect
export type AuditEventRow = typeof auditEvents.$inferSelect
export type DecisionRow = typeof decisions.$inferSelect
export type TaskClaimRow = typeof taskClaims.$inferSelect
export type HandoffRow = typeof handoffs.$inferSelect
export type MessageRow = typeof messages.$inferSelect

/**
 * Idempotent DDL run once when the local DB is opened. Enforces the enum CHECK
 * constraints and the partial UNIQUE indexes (the atomic-claim and single-live-
 * session guarantees) that the drizzle objects above intentionally omit. Keep
 * this in sync with the table definitions above.
 */
export const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_label TEXT NOT NULL,
  cwd_hash TEXT NOT NULL,
  project_scope TEXT,
  current_focus TEXT,
  claimed_issue_number INTEGER,
  claimed_repo_full_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','gone')),
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_sessions_last_seen_idx ON agent_sessions (last_seen_at);
CREATE INDEX IF NOT EXISTS agent_sessions_status_idx ON agent_sessions (status);
-- At most one live session per checkout. Makes checkin convergence atomic.
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_cwd_live_uq
  ON agent_sessions (cwd_hash) WHERE status <> 'gone';

CREATE TABLE IF NOT EXISTS file_activity (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  repo_full_name TEXT,
  tool TEXT NOT NULL CHECK (tool IN ('Write','Edit','MultiEdit','NotebookEdit')),
  touched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_activity_touched_at_idx ON file_activity (touched_at);
CREATE INDEX IF NOT EXISTS file_activity_session_idx ON file_activity (agent_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS file_activity_session_path_uq
  ON file_activity (agent_session_id, file_path);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  agent_session_id TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_type_idx ON audit_events (event_type);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events (created_at);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  decision_key TEXT NOT NULL,
  content TEXT NOT NULL,
  decision_type TEXT NOT NULL DEFAULT 'other'
    CHECK (decision_type IN ('architecture','tooling','process','scope','other')),
  project_scope TEXT,
  author_agent_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','pending','superseded','rejected')),
  supersedes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_key_idx ON decisions (decision_key);
CREATE INDEX IF NOT EXISTS decisions_status_idx ON decisions (status);
CREATE INDEX IF NOT EXISTS decisions_created_at_idx ON decisions (created_at);
-- Repair DBs created before the unique index existed: keep only the newest
-- active decision per key, then enforce uniqueness. Makes "conflicts are loud"
-- a DB-level guarantee instead of an application-level convention.
UPDATE decisions SET status='superseded'
  WHERE status='active' AND EXISTS (
    SELECT 1 FROM decisions d2
    WHERE d2.decision_key = decisions.decision_key AND d2.status='active'
      AND (d2.created_at > decisions.created_at
        OR (d2.created_at = decisions.created_at AND d2.id > decisions.id))
  );
CREATE UNIQUE INDEX IF NOT EXISTS decisions_active_key_uq
  ON decisions (decision_key) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS task_claims (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  claimed_by_agent_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed','in_progress','pr_open','released','completed')),
  pr_number INTEGER,
  notes TEXT,
  claimed_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_claims_repo_issue_idx ON task_claims (repo_full_name, issue_number);
CREATE INDEX IF NOT EXISTS task_claims_status_idx ON task_claims (status);
CREATE INDEX IF NOT EXISTS task_claims_expires_idx ON task_claims (expires_at);
-- At most one live claim per (repo, issue): powers atomic INSERT ... ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS task_claims_live_uq
  ON task_claims (repo_full_name, issue_number)
  WHERE status IN ('claimed','in_progress','pr_open');

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  from_agent_session_id TEXT NOT NULL,
  to_agent_session_id TEXT,
  project_scope TEXT,
  context TEXT NOT NULL,
  state TEXT,
  suggested_next_actions TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','completed','expired')),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_status_idx ON handoffs (status);
CREATE INDEX IF NOT EXISTS handoffs_to_agent_idx ON handoffs (to_agent_session_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent_session_id TEXT NOT NULL,
  to_agent_session_id TEXT NOT NULL,
  repo_full_name TEXT,
  -- CHECK lists must stay in sync with MESSAGE_KINDS / MESSAGE_STATUSES in constants.ts
  kind TEXT NOT NULL CHECK (kind IN ('message','collision','decision')),
  body TEXT NOT NULL,
  requires_response INTEGER NOT NULL DEFAULT 0,
  related_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','responded','dismissed')),
  response TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_to_status_idx ON messages (to_agent_session_id, status);
CREATE INDEX IF NOT EXISTS messages_from_status_idx ON messages (from_agent_session_id, status);
CREATE INDEX IF NOT EXISTS messages_expires_idx ON messages (expires_at);
`

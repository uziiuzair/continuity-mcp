// Wire DTOs (snake_case, exactly what the MCP tools and the Worker emit) plus
// the discriminated conflict result that both backends use to surface "loud"
// conflicts (duplicate decision key, already-claimed issue) without throwing.

import type {
  CLAIM_STATUSES,
  DECISION_STATUSES,
  DECISION_TYPES,
  FILE_TOOLS,
  HANDOFF_STATUSES,
  MESSAGE_KINDS,
  MESSAGE_STATUSES,
  SESSION_STATUSES,
} from "./constants.js"

export type SessionStatus = (typeof SESSION_STATUSES)[number]
export type DecisionType = (typeof DECISION_TYPES)[number]
export type DecisionStatus = (typeof DECISION_STATUSES)[number]
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number]
export type FileTool = (typeof FILE_TOOLS)[number]
export type MessageKind = (typeof MESSAGE_KINDS)[number]
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

/**
 * The acting identity behind a request. The Worker resolves this from the
 * Bearer API key (a real teammate). The local backend fabricates a constant
 * single-user identity. The query layer never branches on which.
 */
export type ContinuityIdentity = {
  userId: string
  userName: string
  githubUsername: string | null
}

/**
 * Result of a write that can lose a race or hit a uniqueness conflict.
 * `conflict: true` carries the existing row so the caller can supersede or back
 * off; `conflict: false` carries the row that was written.
 */
export type ConflictResult<T> = { conflict: true; existing: T } | { conflict: false; result: T }

// ---- Presence ----

export type CheckinResult = { session_id: string; reused: boolean }

export type ActiveSession = {
  session_id: string
  agent_label: string
  user_name: string
  project_scope: string | null
  current_focus: string | null
  claimed_issue_number: number | null
  claimed_repo_full_name: string | null
  status: SessionStatus
  last_seen_at: string
}

export type SessionDetail = {
  session_id: string
  user_id: string | null
  agent_label: string
  cwd_hash: string
  project_scope: string | null
  current_focus: string | null
  claimed_issue_number: number | null
  claimed_repo_full_name: string | null
  status: SessionStatus
  started_at: string
  last_seen_at: string
  ended_at: string | null
}

export type RecentFileActivity = {
  file_path: string
  tool: FileTool
  repo_full_name: string | null
  touched_at: string
  agent_session_id: string
  agent_label: string
  user_name: string
}

// ---- Decisions ----

export type Decision = {
  id: string
  decision_key: string
  content: string
  decision_type: DecisionType
  project_scope: string | null
  author_user_id: string | null
  author_agent_session_id: string | null
  status: DecisionStatus
  supersedes: string | null
  created_at: string
}

// ---- Task claims ----

export type TaskClaim = {
  id: string
  repo_full_name: string
  issue_number: number
  claimed_by_user_id: string | null
  claimed_by_agent_session_id: string | null
  status: ClaimStatus
  pr_number: number | null
  notes: string | null
  claimed_at: string
  last_activity_at: string
  expires_at: string
  // Present only on list responses (joined from users / agent_sessions).
  claimed_by_user_name?: string
  claimed_by_agent_label?: string | null
}

// ---- Handoffs ----

export type Handoff = {
  id: string
  from_agent_session_id: string
  to_agent_session_id: string | null
  to_user_id: string | null
  project_scope: string | null
  context: string
  state: string | null
  suggested_next_actions: string | null
  status: HandoffStatus
  created_at: string
  accepted_at: string | null
  completed_at: string | null
}

// ---- Audit ----

export type AuditEvent = {
  id: string
  event_type: string
  user_id: string | null
  agent_session_id: string | null
  payload: string | null
  created_at: string
}

// ---- Messages ----

export type Message = {
  id: string
  from_agent_session_id: string
  to_agent_session_id: string
  repo_full_name: string | null
  kind: MessageKind
  body: string
  requires_response: boolean
  related_key: string | null
  status: MessageStatus
  response: string | null
  created_at: string
  responded_at: string | null
  expires_at: string
  // Joined for display on list/pending responses.
  from_agent_label?: string
  from_user_name?: string
}

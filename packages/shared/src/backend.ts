// The single seam between the MCP tools and storage.
//
// Every coordination tool calls a method on this interface and nothing else.
// Two implementations satisfy it:
//   - RemoteBackend (packages/mcp): HTTPS → the Cloudflare Worker (team flavor)
//   - LocalBackend  (packages/mcp): better-sqlite3 on one machine (local flavor)
// The Worker's HTTP routes expose the same surface over the wire.
//
// Conventions:
//   - Writes that can lose a uniqueness race (decisionWrite, taskClaim) return a
//     ConflictResult instead of throwing, so the model sees the conflicting row.
//   - Other failures (not_found, validation) reject the promise.
//   - All timestamps in returned DTOs are ISO-8601 strings.

import type {
  ActiveSession,
  AuditEvent,
  CheckinResult,
  ConflictResult,
  Decision,
  DecisionType,
  FileTool,
  Handoff,
  RecentFileActivity,
  SessionDetail,
  TaskClaim,
} from "./types.js"

export type CheckinArgs = {
  agent_label: string
  cwd_hash: string
  project_scope?: string | null
  current_focus?: string | null
}

export type ListActiveArgs = {
  project_scope?: string
  max_age_seconds?: number
  exclude_session?: string
}

export type FileActivityArgs = {
  session_id: string
  repo_full_name?: string | null
  files: { path: string; tool: FileTool }[]
}

export type RecentFileActivityArgs = {
  since_seconds?: number
  exclude_session?: string
  path_prefix?: string
  limit?: number
}

export type DecisionWriteArgs = {
  decision_key: string
  content: string
  decision_type?: DecisionType
  project_scope?: string | null
  author_agent_session_id?: string | null
  supersedes?: string | null
}

export type DecisionRecentArgs = { since?: string; scope?: string; limit?: number }
export type DecisionGetByKeyArgs = { key: string; scope?: string }
export type DecisionSupersedeArgs = {
  existing_id: string
  new_content: string
  reason?: string
  author_agent_session_id?: string | null
}

export type TaskClaimArgs = {
  repo_full_name: string
  issue_number: number
  agent_session_id?: string | null
  notes?: string | null
}
export type TaskUpdateArgs = {
  claim_id: string
  status?: TaskClaim["status"]
  pr_number?: number
  notes?: string
}
export type TaskListArgs = { status?: TaskClaim["status"]; scope?: string; limit?: number }

export type HandoffCreateArgs = {
  from_session_id: string
  to_session_id?: string | null
  to_user_id?: string | null
  project_scope?: string | null
  context: string
  state?: string | null
  suggested_next_actions?: string | null
}
export type HandoffPendingArgs = {
  agent_session_id?: string
  include_broadcast?: boolean
  project_scope?: string
}

export type AuditRecentArgs = { since?: string; type?: string; limit?: number }

export interface ContinuityBackend {
  // ---- Presence (driven by the shim/hooks, not the model) ----
  checkin(args: CheckinArgs): Promise<CheckinResult>
  heartbeat(args: { session_id: string; current_focus?: string }): Promise<void>
  checkout(args: { session_id: string; reason?: string }): Promise<void>
  listActive(args: ListActiveArgs): Promise<{ sessions: ActiveSession[] }>
  getSession(id: string): Promise<{ session: SessionDetail | null }>
  fileActivity(args: FileActivityArgs): Promise<{ ok: boolean; count: number }>
  recentFileActivity(args: RecentFileActivityArgs): Promise<{ activity: RecentFileActivity[] }>
  auditEvent(args: { event_type: string; session_id?: string; payload?: unknown }): Promise<void>

  // ---- Decisions ----
  decisionWrite(args: DecisionWriteArgs): Promise<ConflictResult<Decision>>
  decisionRecent(args: DecisionRecentArgs): Promise<{ decisions: Decision[] }>
  decisionGetByKey(args: DecisionGetByKeyArgs): Promise<{ decision: Decision | null }>
  decisionSupersede(args: DecisionSupersedeArgs): Promise<{ decision: Decision }>

  // ---- Task claims ----
  taskClaim(args: TaskClaimArgs): Promise<ConflictResult<TaskClaim>>
  taskUpdate(args: TaskUpdateArgs): Promise<{ claim: TaskClaim }>
  taskRelease(args: { claim_id: string; reason?: string }): Promise<{ claim: TaskClaim }>
  taskComplete(args: { claim_id: string; outcome?: string }): Promise<{ claim: TaskClaim }>
  taskList(args: TaskListArgs): Promise<{ claims: TaskClaim[] }>

  // ---- Handoffs ----
  handoffCreate(args: HandoffCreateArgs): Promise<{ handoff: Handoff }>
  handoffPending(args: HandoffPendingArgs): Promise<{ handoffs: Handoff[] }>
  handoffAccept(args: { handoff_id: string; agent_session_id?: string }): Promise<{ handoff: Handoff }>
  handoffComplete(args: { handoff_id: string; outcome?: string }): Promise<{ handoff: Handoff }>

  // ---- Audit ----
  auditRecent(args: AuditRecentArgs): Promise<{ events: AuditEvent[] }>
}

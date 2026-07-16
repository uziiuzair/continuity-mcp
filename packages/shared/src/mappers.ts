// Row → wire-DTO mappers, shared by both backends and the Worker.
//
// Each input type is structural and makes the user-FK fields OPTIONAL, so the
// Postgres `$inferSelect` rows (which have user ids) and the SQLite rows (which
// don't) are both assignable. Timestamps accept `Date | string` and normalize
// through `toIso`, so one mapper serializes either dialect's row.

import { type TimestampLike, toIso, toIsoOrNull } from "./time.js"
import type {
  ActiveSession,
  AuditEvent,
  ClaimStatus,
  Decision,
  DecisionStatus,
  DecisionType,
  Handoff,
  HandoffStatus,
  Message,
  MessageKind,
  MessageStatus,
  RecentFileActivity,
  SessionDetail,
  SessionStatus,
  TaskClaim,
} from "./types.js"

type SessionRowLike = {
  id: string
  userId?: string | null
  agentLabel: string
  cwdHash: string
  projectScope: string | null
  currentFocus: string | null
  claimedIssueNumber: number | null
  claimedRepoFullName: string | null
  status: SessionStatus
  startedAt: TimestampLike
  lastSeenAt: TimestampLike
  endedAt: TimestampLike | null
}

export function toSessionDetail(r: SessionRowLike): SessionDetail {
  return {
    session_id: r.id,
    user_id: r.userId ?? null,
    agent_label: r.agentLabel,
    cwd_hash: r.cwdHash,
    project_scope: r.projectScope,
    current_focus: r.currentFocus,
    claimed_issue_number: r.claimedIssueNumber,
    claimed_repo_full_name: r.claimedRepoFullName,
    status: r.status,
    started_at: toIso(r.startedAt),
    last_seen_at: toIso(r.lastSeenAt),
    ended_at: toIsoOrNull(r.endedAt),
  }
}

type ActiveSessionRowLike = {
  id: string
  agentLabel: string
  projectScope: string | null
  currentFocus: string | null
  claimedIssueNumber: number | null
  claimedRepoFullName: string | null
  status: SessionStatus
  lastSeenAt: TimestampLike
}

export function toActiveSession(r: ActiveSessionRowLike, userName: string): ActiveSession {
  return {
    session_id: r.id,
    agent_label: r.agentLabel,
    user_name: userName,
    project_scope: r.projectScope,
    current_focus: r.currentFocus,
    claimed_issue_number: r.claimedIssueNumber,
    claimed_repo_full_name: r.claimedRepoFullName,
    status: r.status,
    last_seen_at: toIso(r.lastSeenAt),
  }
}

type FileActivityRowLike = {
  filePath: string
  tool: RecentFileActivity["tool"]
  repoFullName: string | null
  touchedAt: TimestampLike
  agentSessionId: string
}

export function toRecentFileActivity(
  r: FileActivityRowLike,
  joined: { agentLabel: string; userName: string },
): RecentFileActivity {
  return {
    file_path: r.filePath,
    tool: r.tool,
    repo_full_name: r.repoFullName,
    touched_at: toIso(r.touchedAt),
    agent_session_id: r.agentSessionId,
    agent_label: joined.agentLabel,
    user_name: joined.userName,
  }
}

type DecisionRowLike = {
  id: string
  decisionKey: string
  content: string
  decisionType: DecisionType
  projectScope: string | null
  authorUserId?: string | null
  authorAgentSessionId: string | null
  status: DecisionStatus
  supersedes: string | null
  createdAt: TimestampLike
}

export function toDecision(r: DecisionRowLike): Decision {
  return {
    id: r.id,
    decision_key: r.decisionKey,
    content: r.content,
    decision_type: r.decisionType,
    project_scope: r.projectScope,
    author_user_id: r.authorUserId ?? null,
    author_agent_session_id: r.authorAgentSessionId,
    status: r.status,
    supersedes: r.supersedes,
    created_at: toIso(r.createdAt),
  }
}

type TaskClaimRowLike = {
  id: string
  repoFullName: string
  issueNumber: number
  claimedByUserId?: string | null
  claimedByAgentSessionId: string | null
  status: ClaimStatus
  prNumber: number | null
  notes: string | null
  claimedAt: TimestampLike
  lastActivityAt: TimestampLike
  expiresAt: TimestampLike
}

export function toTaskClaim(
  r: TaskClaimRowLike,
  joined?: { userName?: string; agentLabel?: string | null },
): TaskClaim {
  const base: TaskClaim = {
    id: r.id,
    repo_full_name: r.repoFullName,
    issue_number: r.issueNumber,
    claimed_by_user_id: r.claimedByUserId ?? null,
    claimed_by_agent_session_id: r.claimedByAgentSessionId,
    status: r.status,
    pr_number: r.prNumber,
    notes: r.notes,
    claimed_at: toIso(r.claimedAt),
    last_activity_at: toIso(r.lastActivityAt),
    expires_at: toIso(r.expiresAt),
  }
  if (joined?.userName !== undefined) base.claimed_by_user_name = joined.userName
  if (joined?.agentLabel !== undefined) base.claimed_by_agent_label = joined.agentLabel
  return base
}

type HandoffRowLike = {
  id: string
  fromAgentSessionId: string
  toAgentSessionId: string | null
  toUserId?: string | null
  projectScope: string | null
  context: string
  state: string | null
  suggestedNextActions: string | null
  status: HandoffStatus
  createdAt: TimestampLike
  acceptedAt: TimestampLike | null
  completedAt: TimestampLike | null
}

export function toHandoff(r: HandoffRowLike): Handoff {
  return {
    id: r.id,
    from_agent_session_id: r.fromAgentSessionId,
    to_agent_session_id: r.toAgentSessionId,
    to_user_id: r.toUserId ?? null,
    project_scope: r.projectScope,
    context: r.context,
    state: r.state,
    suggested_next_actions: r.suggestedNextActions,
    status: r.status,
    created_at: toIso(r.createdAt),
    accepted_at: toIsoOrNull(r.acceptedAt),
    completed_at: toIsoOrNull(r.completedAt),
  }
}

type AuditEventRowLike = {
  id: string
  eventType: string
  userId?: string | null
  agentSessionId: string | null
  payload: string | null
  createdAt: TimestampLike
}

export function toAuditEvent(r: AuditEventRowLike): AuditEvent {
  return {
    id: r.id,
    event_type: r.eventType,
    user_id: r.userId ?? null,
    agent_session_id: r.agentSessionId,
    payload: r.payload,
    created_at: toIso(r.createdAt),
  }
}

type MessageRowLike = {
  id: string
  fromAgentSessionId: string
  toAgentSessionId: string
  repoFullName: string | null
  kind: MessageKind
  body: string
  requiresResponse: number | boolean
  relatedKey: string | null
  status: MessageStatus
  response: string | null
  createdAt: TimestampLike
  respondedAt: TimestampLike | null
  expiresAt: TimestampLike
  fromAgentLabel?: string | null
  fromUserName?: string | null
}

export function toMessage(r: MessageRowLike): Message {
  return {
    id: r.id,
    from_agent_session_id: r.fromAgentSessionId,
    to_agent_session_id: r.toAgentSessionId,
    repo_full_name: r.repoFullName,
    kind: r.kind,
    body: r.body,
    requires_response: Boolean(r.requiresResponse),
    related_key: r.relatedKey,
    status: r.status,
    response: r.response,
    created_at: toIso(r.createdAt),
    responded_at: toIsoOrNull(r.respondedAt),
    expires_at: toIso(r.expiresAt),
    from_agent_label: r.fromAgentLabel ?? undefined,
    from_user_name: r.fromUserName ?? undefined,
  }
}

// RemoteBackend — the team flavor. Implements ContinuityBackend by proxying to
// the Cloudflare Worker over HTTPS with a Bearer API key. The Worker owns the
// Postgres logic and (for the team extras) GitHub/Slack tokens, which never
// reach the laptop. Mirrors the original shim's HTTP client, retyped to the
// interface and with 409 responses unwrapped into ConflictResult.

import type {
  ActiveSession,
  AuditEvent,
  AuditRecentArgs,
  CheckinArgs,
  CheckinResult,
  ConflictResult,
  ContinuityBackend,
  Decision,
  DecisionGetByKeyArgs,
  DecisionRecentArgs,
  DecisionSupersedeArgs,
  DecisionWriteArgs,
  FileActivityArgs,
  Handoff,
  HandoffCreateArgs,
  HandoffPendingArgs,
  ListActiveArgs,
  RecentFileActivity,
  RecentFileActivityArgs,
  SessionDetail,
  TaskClaim,
  TaskClaimArgs,
  TaskListArgs,
  TaskUpdateArgs,
} from "@continuity/shared"

type QueryParams = Record<string, string | number | boolean | undefined>

// Team-flavor-only surface. These tools proxy to the Cloudflare Worker, which
// brokers GitHub/Slack tokens that never reach the laptop. The local SQLite
// flavor does NOT implement them, so they live on a separate interface from
// ContinuityBackend (LocalBackend must not be forced to provide them). Only
// RemoteBackend satisfies this, and the tools are only registered in remote mode.
export interface TeamBackend {
  githubListProjects(args: { repo?: string }): Promise<unknown>
  githubListOpenIssues(args: {
    repo?: string
    label?: string
    assigned_to_me?: boolean
  }): Promise<unknown>
  githubClaimIssue(args: {
    repo?: string
    issue_number: number
    agent_session_id?: string
  }): Promise<unknown>
  githubOpenPr(args: {
    repo?: string
    issue_number: number
    branch: string
    title: string
    body: string
  }): Promise<unknown>
  githubUpdateStatus(args: {
    repo?: string
    issue_number: number
    new_status: string
    notes?: string
  }): Promise<unknown>
  planCheck(args: {
    task_description: string
    repo?: string
    agent_session_id?: string
    bypass?: boolean
  }): Promise<unknown>
  planCurrent(args: { repo?: string }): Promise<unknown>
  escalate(args: {
    reason: string
    context: string
    suggested_questions?: string
    repo?: string
    agent_session_id?: string
  }): Promise<unknown>
}

export class RemoteBackend implements ContinuityBackend, TeamBackend {
  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
  ) {}

  // ---- Presence ----

  checkin(args: CheckinArgs): Promise<CheckinResult> {
    return this.post<CheckinResult>("/agent/checkin", args)
  }

  async heartbeat(args: { session_id: string; current_focus?: string }): Promise<void> {
    await this.post("/agent/heartbeat", args)
  }

  async checkout(args: { session_id: string; reason?: string }): Promise<void> {
    await this.post("/agent/checkout", args)
  }

  listActive(args: ListActiveArgs): Promise<{ sessions: ActiveSession[] }> {
    return this.get("/agent/list_active", args)
  }

  getSession(id: string): Promise<{ session: SessionDetail | null }> {
    return this.get("/agent/get", { id })
  }

  fileActivity(args: FileActivityArgs): Promise<{ ok: boolean; count: number }> {
    return this.post("/agent/file_activity", args)
  }

  recentFileActivity(args: RecentFileActivityArgs): Promise<{ activity: RecentFileActivity[] }> {
    return this.get("/agent/file_activity/recent", args)
  }

  async auditEvent(args: { event_type: string; session_id?: string; payload?: unknown }): Promise<void> {
    await this.post("/agent/audit_event", args)
  }

  // ---- Decisions ----

  async decisionWrite(args: DecisionWriteArgs): Promise<ConflictResult<Decision>> {
    const { status, body } = await this.raw("POST", "/decisions/write", args)
    if (status === 409) return { conflict: true, existing: (body as { existing: Decision }).existing }
    return { conflict: false, result: (body as { decision: Decision }).decision }
  }

  decisionRecent(args: DecisionRecentArgs): Promise<{ decisions: Decision[] }> {
    return this.get("/decisions/recent", args)
  }

  decisionGetByKey(args: DecisionGetByKeyArgs): Promise<{ decision: Decision | null }> {
    return this.get("/decisions/get_by_key", args)
  }

  decisionSupersede(args: DecisionSupersedeArgs): Promise<{ decision: Decision }> {
    return this.post("/decisions/supersede", args)
  }

  // ---- Task claims ----

  async taskClaim(args: TaskClaimArgs): Promise<ConflictResult<TaskClaim>> {
    const { status, body } = await this.raw("POST", "/tasks/claim", args)
    if (status === 409) return { conflict: true, existing: (body as { claim: TaskClaim }).claim }
    return { conflict: false, result: (body as { claim: TaskClaim }).claim }
  }

  taskUpdate(args: TaskUpdateArgs): Promise<{ claim: TaskClaim }> {
    return this.post("/tasks/update", args)
  }

  taskRelease(args: { claim_id: string; reason?: string }): Promise<{ claim: TaskClaim }> {
    return this.post("/tasks/release", args)
  }

  taskComplete(args: { claim_id: string; outcome?: string }): Promise<{ claim: TaskClaim }> {
    return this.post("/tasks/complete", args)
  }

  taskList(args: TaskListArgs): Promise<{ claims: TaskClaim[] }> {
    return this.get("/tasks/list", args)
  }

  // ---- Handoffs ----

  handoffCreate(args: HandoffCreateArgs): Promise<{ handoff: Handoff }> {
    return this.post("/handoffs/create", args)
  }

  handoffPending(args: HandoffPendingArgs): Promise<{ handoffs: Handoff[] }> {
    return this.get("/handoffs/pending", args)
  }

  handoffAccept(args: { handoff_id: string; agent_session_id?: string }): Promise<{ handoff: Handoff }> {
    return this.post("/handoffs/accept", args)
  }

  handoffComplete(args: { handoff_id: string; outcome?: string }): Promise<{ handoff: Handoff }> {
    return this.post("/handoffs/complete", args)
  }

  // ---- Audit ----

  auditRecent(args: AuditRecentArgs): Promise<{ events: AuditEvent[] }> {
    return this.get("/audit/recent", args)
  }

  // ---- Team-flavor extras (GitHub Projects) ----
  // The Worker brokers all GitHub access; claiming an issue assigns the *human*
  // who owns this agent, not the agent itself.

  githubListProjects(args: { repo?: string }): Promise<unknown> {
    return this.get("/github/projects/list", { repo: args.repo })
  }

  githubListOpenIssues(args: {
    repo?: string
    label?: string
    assigned_to_me?: boolean
  }): Promise<unknown> {
    return this.get("/github/projects/list_open_issues", {
      repo: args.repo,
      label: args.label,
      assigned_to_me: args.assigned_to_me,
    })
  }

  githubClaimIssue(args: {
    repo?: string
    issue_number: number
    agent_session_id?: string
  }): Promise<unknown> {
    return this.post("/github/projects/claim", args)
  }

  githubOpenPr(args: {
    repo?: string
    issue_number: number
    branch: string
    title: string
    body: string
  }): Promise<unknown> {
    return this.post("/github/projects/open_pr", args)
  }

  githubUpdateStatus(args: {
    repo?: string
    issue_number: number
    new_status: string
    notes?: string
  }): Promise<unknown> {
    return this.post("/github/projects/update_status", args)
  }

  // ---- Team-flavor extras (plan/phase + escalation) ----

  planCheck(args: {
    task_description: string
    repo?: string
    agent_session_id?: string
    bypass?: boolean
  }): Promise<unknown> {
    return this.post("/plan/check", args)
  }

  planCurrent(args: { repo?: string }): Promise<unknown> {
    return this.get("/plan/current", { repo: args.repo })
  }

  escalate(args: {
    reason: string
    context: string
    suggested_questions?: string
    repo?: string
    agent_session_id?: string
  }): Promise<unknown> {
    return this.post("/escalation/post", args)
  }

  // ---- transport ----

  private base(): string {
    return this.serverUrl.replace(/\/+$/, "")
  }

  private async raw(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.base()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    })
    // 409 is an expected conflict (decision/claim) — return it for unwrapping.
    if (res.status === 409) return { status: 409, body: await res.json() }
    if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${await res.text()}`)
    return { status: res.status, body: await res.json() }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const { body: out } = await this.raw("POST", path, body)
    return out as T
  }

  private async get<T>(path: string, params: QueryParams): Promise<T> {
    const url = new URL(`${this.base()}${path}`)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
}

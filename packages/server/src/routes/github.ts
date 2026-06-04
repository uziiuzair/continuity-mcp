import { CLAIM_TTL_MS, LIVE_CLAIM_STATUSES, pgSchema, toTaskClaim } from "@continuity/shared"
import { and, eq, inArray } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { writeAudit } from "../events.js"
import {
  GitHubNotConfiguredError,
  assignIssue,
  isGitHubConfigured,
  listOpenIssues,
  listProjects,
  openPullRequest,
  setIssueProjectStatus,
} from "../github.js"
import type { AppEnv } from "../types.js"

const { agentSessions, projectStateCache, taskClaims, users } = pgSchema

export const githubRoutes = new Hono<AppEnv>()

// Maps GitHub failures to wire responses. The "not configured" case degrades
// gracefully so the Worker still deploys with only DATABASE_URL +
// API_KEY_HMAC_SECRET; real GitHub errors surface as 502.
function handleGitHubError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof GitHubNotConfiguredError) {
    return c.json({ error: "not_configured", feature: "github" }, 503)
  }
  console.error("[continuity-server] github", err)
  return c.json({ error: "github_error", detail: String(err) }, 502)
}

// GET /github/projects/list?repo=  — cached board snapshot, refreshed by cron.
githubRoutes.get("/projects/list", async (c) => {
  const repo = c.req.query("repo")
  if (!repo) return c.json({ error: "invalid_query", detail: "repo required" }, 400)

  // Serve the cron-maintained cache when present even if GitHub isn't live.
  const cached = await c.var.db
    .select()
    .from(projectStateCache)
    .where(eq(projectStateCache.repoFullName, repo))
  if (cached.length > 0) {
    return c.json({
      projects: cached.map((r) => ({
        project_number: r.projectNumber,
        snapshot: JSON.parse(r.snapshot),
        fetched_at: r.fetchedAt.toISOString(),
      })),
    })
  }

  if (!isGitHubConfigured(c.env)) return c.json({ error: "not_configured", feature: "github" }, 503)
  try {
    return c.json({ projects: await listProjects(c.env, repo), cached: false })
  } catch (err) {
    return handleGitHubError(c, err)
  }
})

// GET /github/projects/list_open_issues?repo=&assigned_to_me=&label=
githubRoutes.get("/projects/list_open_issues", async (c) => {
  const repo = c.req.query("repo")
  if (!repo) return c.json({ error: "invalid_query", detail: "repo required" }, 400)
  if (!isGitHubConfigured(c.env)) return c.json({ error: "not_configured", feature: "github" }, 503)
  const label = c.req.query("label")
  const assignedToMe = c.req.query("assigned_to_me") === "true"

  try {
    let issues = await listOpenIssues(c.env, repo)
    if (label) issues = issues.filter((i) => i.labels.includes(label))
    if (assignedToMe) {
      const me = await c.var.db
        .select({ gh: users.githubUsername })
        .from(users)
        .where(eq(users.id, c.var.userId))
        .limit(1)
      const login = me[0]?.gh
      issues = login ? issues.filter((i) => i.assignees.includes(login)) : []
    }

    // Annotate with any live claim so the agent sees what's already taken.
    const claims = await c.var.db
      .select({ issue: taskClaims.issueNumber, status: taskClaims.status })
      .from(taskClaims)
      .where(and(eq(taskClaims.repoFullName, repo), inArray(taskClaims.status, [...LIVE_CLAIM_STATUSES])))
    const claimed = new Map(claims.map((r) => [r.issue, r.status]))
    return c.json({
      issues: issues.map((i) => ({ ...i, claim_status: claimed.get(i.number) ?? null })),
    })
  } catch (err) {
    return handleGitHubError(c, err)
  }
})

// POST /github/projects/claim — body: { repo, issue_number, agent_session_id? }
// Autonomous claim: insert the claim atomically, assign the *human* who owns the
// agent on GitHub, set the board Status to "In Progress", and record the claim
// on the session. Assignment/status are best-effort side effects. The claim row
// itself works without GitHub; the assignment side effects no-op when GitHub
// isn't configured.
githubRoutes.post("/projects/claim", async (c) => {
  const body = await c.req.json<{ repo?: unknown; issue_number?: unknown; agent_session_id?: unknown }>()
  if (typeof body.repo !== "string" || !body.repo) {
    return c.json({ error: "invalid_body", detail: "repo required" }, 400)
  }
  const issueNumber = Number(body.issue_number)
  if (!Number.isInteger(issueNumber)) {
    return c.json({ error: "invalid_body", detail: "issue_number required" }, 400)
  }
  const agentSessionId = typeof body.agent_session_id === "string" ? body.agent_session_id : null
  const now = new Date()

  const inserted = await c.var.db
    .insert(taskClaims)
    .values({
      repoFullName: body.repo,
      issueNumber,
      claimedByUserId: c.var.userId,
      claimedByAgentSessionId: agentSessionId,
      status: "in_progress",
      claimedAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
    })
    .onConflictDoNothing()
    .returning()

  if (!inserted[0]) {
    const current = await c.var.db
      .select()
      .from(taskClaims)
      .where(
        and(
          eq(taskClaims.repoFullName, body.repo),
          eq(taskClaims.issueNumber, issueNumber),
          inArray(taskClaims.status, [...LIVE_CLAIM_STATUSES]),
        ),
      )
      .limit(1)
    return c.json({ error: "already_claimed", claim: current[0] ? toTaskClaim(current[0]) : null }, 409)
  }

  const claim = inserted[0]
  const sideEffects: Record<string, unknown> = {}

  // GitHub side effects are optional: skip cleanly when the App isn't configured.
  if (!isGitHubConfigured(c.env)) {
    sideEffects.github = "not_configured"
  } else {
    // Resolve the human GitHub login and assign them (not the agent).
    const me = await c.var.db
      .select({ gh: users.githubUsername })
      .from(users)
      .where(eq(users.id, c.var.userId))
      .limit(1)
    const login = me[0]?.gh
    if (login) {
      try {
        await assignIssue(c.env, body.repo, issueNumber, login)
        sideEffects.assigned = login
      } catch (err) {
        sideEffects.assign_error = String(err)
      }
      try {
        sideEffects.status_set = await setIssueProjectStatus(c.env, body.repo, issueNumber, "In Progress")
      } catch (err) {
        sideEffects.status_error = String(err)
      }
    } else {
      sideEffects.assign_skipped = "no github_username for user"
    }
  }

  // Record the claim on the session for the presence snapshot.
  if (agentSessionId) {
    await c.var.db
      .update(agentSessions)
      .set({ claimedIssueNumber: issueNumber, claimedRepoFullName: body.repo })
      .where(eq(agentSessions.id, agentSessionId))
  }

  await writeAudit(c.var.db, "task.claim", c.var.userId, agentSessionId, {
    repo: body.repo,
    issue_number: issueNumber,
    ...sideEffects,
  })
  return c.json({ claim: toTaskClaim(claim), side_effects: sideEffects })
})

// POST /github/projects/open_pr
// body: { repo, issue_number?, branch, title, body, base?, claim_id? }
githubRoutes.post("/projects/open_pr", async (c) => {
  const body = await c.req.json<{
    repo?: unknown
    issue_number?: unknown
    branch?: unknown
    title?: unknown
    body?: unknown
    base?: unknown
    claim_id?: unknown
  }>()
  if (typeof body.repo !== "string" || typeof body.branch !== "string" || typeof body.title !== "string") {
    return c.json({ error: "invalid_body", detail: "repo, branch, title required" }, 400)
  }
  if (!isGitHubConfigured(c.env)) return c.json({ error: "not_configured", feature: "github" }, 503)
  const issueNumber = Number.isInteger(Number(body.issue_number)) ? Number(body.issue_number) : undefined

  try {
    const pr = await openPullRequest(c.env, body.repo, {
      branch: body.branch,
      base: typeof body.base === "string" ? body.base : undefined,
      title: body.title,
      body: typeof body.body === "string" ? body.body : "",
      issueNumber,
    })

    if (typeof body.claim_id === "string") {
      await c.var.db
        .update(taskClaims)
        .set({ status: "pr_open", prNumber: pr.number, lastActivityAt: new Date() })
        .where(eq(taskClaims.id, body.claim_id))
    }
    await writeAudit(c.var.db, "pr.opened", c.var.userId, null, {
      repo: body.repo,
      pr_number: pr.number,
      issue_number: issueNumber,
    })
    return c.json({ pr })
  } catch (err) {
    return handleGitHubError(c, err)
  }
})

// POST /github/projects/update_status — body: { repo, issue_number, new_status, notes? }
githubRoutes.post("/projects/update_status", async (c) => {
  const body = await c.req.json<{ repo?: unknown; issue_number?: unknown; new_status?: unknown }>()
  if (typeof body.repo !== "string" || typeof body.new_status !== "string") {
    return c.json({ error: "invalid_body", detail: "repo, new_status required" }, 400)
  }
  const issueNumber = Number(body.issue_number)
  if (!Number.isInteger(issueNumber)) {
    return c.json({ error: "invalid_body", detail: "issue_number required" }, 400)
  }
  if (!isGitHubConfigured(c.env)) return c.json({ error: "not_configured", feature: "github" }, 503)
  try {
    const ok = await setIssueProjectStatus(c.env, body.repo, issueNumber, body.new_status)
    return c.json({ ok })
  } catch (err) {
    return handleGitHubError(c, err)
  }
})

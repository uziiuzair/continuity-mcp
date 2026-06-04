import { CLAIM_TTL_MS, LIVE_CLAIM_STATUSES, pgSchema } from "@continuity/shared"
import { and, eq, inArray, isNotNull } from "drizzle-orm"
import { type Db, makeDb } from "./db.js"
import { GitHubNotConfiguredError, isGitHubConfigured, listOpenIssues, listProjects } from "./github.js"
import type { Bindings } from "./types.js"

const { projectStateCache, taskClaims, users } = pgSchema

// Repos to scan: explicit env list (CONTINUITY_REPOS), else the distinct repos
// that currently have live claims (so we only touch GitHub for boards we're
// actually using).
async function reposToScan(env: Bindings, db: Db): Promise<string[]> {
  if (env.CONTINUITY_REPOS && env.CONTINUITY_REPOS.trim()) {
    return env.CONTINUITY_REPOS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const rows = await db
    .selectDistinct({ repo: taskClaims.repoFullName })
    .from(taskClaims)
    .where(inArray(taskClaims.status, [...LIVE_CLAIM_STATUSES]))
  return rows.map((r) => r.repo)
}

// Refresh the cached Projects v2 snapshot and reconcile GitHub-side assignees
// into synthetic claims (so an agent that calls task claim sees the conflict).
// Best-effort: GitHub being unconfigured or erroring is swallowed so the minute
// cron never fails when the team-flavor extras aren't set up.
export async function runGitHubSync(env: Bindings): Promise<void> {
  if (!isGitHubConfigured(env)) return // not configured; nothing to do
  const db = makeDb(env.DATABASE_URL)

  let repos: string[]
  try {
    repos = await reposToScan(env, db)
  } catch {
    return
  }

  for (const repo of repos) {
    try {
      await refreshProjectCache(env, db, repo)
      await reconcileAssignees(env, db, repo)
    } catch (err) {
      if (err instanceof GitHubNotConfiguredError) return
      console.error("[continuity-server] github-sync", repo, err)
    }
  }
}

async function refreshProjectCache(env: Bindings, db: Db, repo: string): Promise<void> {
  const projects = await listProjects(env, repo)
  const now = new Date()
  for (const p of projects) {
    await db
      .insert(projectStateCache)
      .values({
        repoFullName: repo,
        projectNumber: p.number,
        snapshot: JSON.stringify(p),
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectStateCache.repoFullName, projectStateCache.projectNumber],
        set: { snapshot: JSON.stringify(p), fetchedAt: now },
      })
  }
}

async function reconcileAssignees(env: Bindings, db: Db, repo: string): Promise<void> {
  const issues = await listOpenIssues(env, repo)
  const assigned = issues.filter((i) => i.assignees.length > 0)
  if (assigned.length === 0) return

  // Map github_username -> user id for known teammates.
  const knownUsers = await db
    .select({ id: users.id, gh: users.githubUsername })
    .from(users)
    .where(isNotNull(users.githubUsername))
  const byLogin = new Map(knownUsers.map((u) => [u.gh!.toLowerCase(), u.id]))

  // Existing live claims for this repo, by issue number.
  const live = await db
    .select({ issue: taskClaims.issueNumber })
    .from(taskClaims)
    .where(and(eq(taskClaims.repoFullName, repo), inArray(taskClaims.status, [...LIVE_CLAIM_STATUSES])))
  const liveIssues = new Set(live.map((r) => r.issue))

  const now = new Date()
  for (const issue of assigned) {
    if (liveIssues.has(issue.number)) continue
    const ownerLogin = issue.assignees.map((a) => a.toLowerCase()).find((l) => byLogin.has(l))
    if (!ownerLogin) continue
    const userId = byLogin.get(ownerLogin)!
    // Synthetic claim on behalf of the human who's assigned on GitHub.
    await db
      .insert(taskClaims)
      .values({
        repoFullName: repo,
        issueNumber: issue.number,
        claimedByUserId: userId,
        status: "claimed",
        notes: "synthetic claim reconciled from GitHub assignee",
        claimedAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
      })
      .onConflictDoNothing()
  }
}

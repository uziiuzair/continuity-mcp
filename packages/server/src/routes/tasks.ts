import { CLAIM_TTL_MS, type ClaimStatus, LIVE_CLAIM_STATUSES, pgSchema, toTaskClaim } from "@continuity/shared"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { writeAudit } from "../events.js"
import type { AppEnv } from "../types.js"

const { agentSessions, taskClaims, users } = pgSchema
const ALL_STATUSES: ClaimStatus[] = ["claimed", "in_progress", "pr_open", "released", "completed"]

export const taskRoutes = new Hono<AppEnv>()

async function liveClaim(db: AppEnv["Variables"]["db"], repo: string, issue: number) {
  const rows = await db
    .select()
    .from(taskClaims)
    .where(
      and(
        eq(taskClaims.repoFullName, repo),
        eq(taskClaims.issueNumber, issue),
        inArray(taskClaims.status, [...LIVE_CLAIM_STATUSES]),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

// POST /tasks/claim — atomic via the partial unique index; 409 on loss.
taskRoutes.post("/claim", async (c) => {
  const body = await c.req.json<{ repo_full_name?: unknown; issue_number?: unknown; agent_session_id?: unknown; notes?: unknown }>()
  if (typeof body.repo_full_name !== "string" || !body.repo_full_name)
    return c.json({ error: "invalid_body", detail: "repo_full_name required" }, 400)
  const issueNumber = Number(body.issue_number)
  if (!Number.isInteger(issueNumber)) return c.json({ error: "invalid_body", detail: "issue_number required" }, 400)
  const agentSessionId = typeof body.agent_session_id === "string" ? body.agent_session_id : null
  const notes = typeof body.notes === "string" ? body.notes : null
  const now = new Date()

  // Bounded retry: insert; if blocked, re-select the live claim and 409 with it.
  // If no live claim exists (it was released/expired in the gap), the partial
  // unique index is free again — retry the insert. This guarantees the 409 body
  // always carries a real claim, matching LocalBackend's ConflictResult.
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await c.var.db
      .insert(taskClaims)
      .values({
        repoFullName: body.repo_full_name,
        issueNumber,
        claimedByUserId: c.var.userId,
        claimedByAgentSessionId: agentSessionId,
        status: "claimed",
        notes,
        claimedAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
      })
      .onConflictDoNothing()
      .returning()

    if (inserted[0]) {
      await writeAudit(c.var.db, "task.claim", c.var.userId, agentSessionId, { repo_full_name: body.repo_full_name, issue_number: issueNumber })
      return c.json({ claim: toTaskClaim(inserted[0]) })
    }
    const current = await liveClaim(c.var.db, body.repo_full_name, issueNumber)
    if (current) return c.json({ error: "already_claimed", claim: toTaskClaim(current) }, 409)
    // No live claim: the conflicting claim vanished. Loop to retry the insert.
  }
  return c.json({ error: "claim_conflict_without_live_claim" }, 409)
})

// POST /tasks/update — body: { claim_id, status?, pr_number?, notes? }
taskRoutes.post("/update", async (c) => {
  const body = await c.req.json<{ claim_id?: unknown; status?: unknown; pr_number?: unknown; notes?: unknown }>()
  if (typeof body.claim_id !== "string" || !body.claim_id)
    return c.json({ error: "invalid_body", detail: "claim_id required" }, 400)
  const set: Partial<typeof taskClaims.$inferInsert> = { lastActivityAt: new Date() }
  if (typeof body.status === "string" && ALL_STATUSES.includes(body.status as ClaimStatus)) set.status = body.status as ClaimStatus
  if (Number.isInteger(Number(body.pr_number))) set.prNumber = Number(body.pr_number)
  if (typeof body.notes === "string") set.notes = body.notes
  const updated = await c.var.db
    .update(taskClaims)
    .set(set)
    .where(and(eq(taskClaims.id, body.claim_id), eq(taskClaims.claimedByUserId, c.var.userId)))
    .returning()
  if (!updated[0]) return c.json({ error: "not_found" }, 404)
  return c.json({ claim: toTaskClaim(updated[0]) })
})

// POST /tasks/release — body: { claim_id, reason? }
taskRoutes.post("/release", async (c) => {
  const body = await c.req.json<{ claim_id?: unknown; reason?: unknown }>()
  if (typeof body.claim_id !== "string" || !body.claim_id)
    return c.json({ error: "invalid_body", detail: "claim_id required" }, 400)
  const updated = await c.var.db
    .update(taskClaims)
    .set({ status: "released", lastActivityAt: new Date() })
    .where(eq(taskClaims.id, body.claim_id))
    .returning()
  if (!updated[0]) return c.json({ error: "not_found" }, 404)
  await writeAudit(c.var.db, "task.release", c.var.userId, null, { claim_id: body.claim_id, reason: typeof body.reason === "string" ? body.reason : null })
  return c.json({ claim: toTaskClaim(updated[0]) })
})

// POST /tasks/complete — body: { claim_id, outcome? }
taskRoutes.post("/complete", async (c) => {
  const body = await c.req.json<{ claim_id?: unknown; outcome?: unknown }>()
  if (typeof body.claim_id !== "string" || !body.claim_id)
    return c.json({ error: "invalid_body", detail: "claim_id required" }, 400)
  const updated = await c.var.db
    .update(taskClaims)
    .set({ status: "completed", lastActivityAt: new Date() })
    .where(eq(taskClaims.id, body.claim_id))
    .returning()
  if (!updated[0]) return c.json({ error: "not_found" }, 404)
  await writeAudit(c.var.db, "task.complete", c.var.userId, null, { claim_id: body.claim_id, outcome: typeof body.outcome === "string" ? body.outcome : null })
  return c.json({ claim: toTaskClaim(updated[0]) })
})

// GET /tasks/list?status=&scope=&limit=
taskRoutes.get("/list", async (c) => {
  const status = c.req.query("status")
  const repo = c.req.query("scope") ?? c.req.query("repo")
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200)
  const conditions = []
  if (status && ALL_STATUSES.includes(status as ClaimStatus)) conditions.push(eq(taskClaims.status, status as ClaimStatus))
  else conditions.push(inArray(taskClaims.status, [...LIVE_CLAIM_STATUSES]))
  if (repo) conditions.push(eq(taskClaims.repoFullName, repo))

  const rows = await c.var.db
    .select({ claim: taskClaims, userName: users.name, agentLabel: agentSessions.agentLabel })
    .from(taskClaims)
    .innerJoin(users, eq(taskClaims.claimedByUserId, users.id))
    .leftJoin(agentSessions, eq(taskClaims.claimedByAgentSessionId, agentSessions.id))
    .where(and(...conditions))
    .orderBy(desc(taskClaims.lastActivityAt))
    .limit(limit)

  return c.json({ claims: rows.map((r) => toTaskClaim(r.claim, { userName: r.userName, agentLabel: r.agentLabel })) })
})

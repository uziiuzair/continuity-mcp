import { pgSchema, toHandoff } from "@continuity/shared"
import { and, desc, eq, isNull, or } from "drizzle-orm"
import { Hono } from "hono"
import { writeAudit } from "../events.js"
import type { AppEnv } from "../types.js"

const { handoffs } = pgSchema

export const handoffRoutes = new Hono<AppEnv>()

// POST /handoffs/create
handoffRoutes.post("/create", async (c) => {
  const body = await c.req.json<{
    from_session_id?: unknown
    to_session_id?: unknown
    to_user_id?: unknown
    project_scope?: unknown
    context?: unknown
    state?: unknown
    suggested_next_actions?: unknown
  }>()
  if (typeof body.from_session_id !== "string" || !body.from_session_id)
    return c.json({ error: "invalid_body", detail: "from_session_id required" }, 400)
  if (typeof body.context !== "string" || !body.context)
    return c.json({ error: "invalid_body", detail: "context required" }, 400)

  const inserted = await c.var.db
    .insert(handoffs)
    .values({
      fromAgentSessionId: body.from_session_id,
      toAgentSessionId: typeof body.to_session_id === "string" ? body.to_session_id : null,
      toUserId: typeof body.to_user_id === "string" ? body.to_user_id : null,
      projectScope: typeof body.project_scope === "string" ? body.project_scope : null,
      context: body.context,
      state: typeof body.state === "string" ? body.state : null,
      suggestedNextActions: typeof body.suggested_next_actions === "string" ? body.suggested_next_actions : null,
      status: "pending",
    })
    .returning()
  await writeAudit(c.var.db, "handoff.create", c.var.userId, body.from_session_id, {
    to_session_id: inserted[0]!.toAgentSessionId,
    to_user_id: inserted[0]!.toUserId,
  })
  return c.json({ handoff: toHandoff(inserted[0]!) })
})

// GET /handoffs/pending?agent_session_id=&include_broadcast=&project_scope=
handoffRoutes.get("/pending", async (c) => {
  const agentSessionId = c.req.query("agent_session_id")
  const includeBroadcast = c.req.query("include_broadcast") !== "false"
  const projectScope = c.req.query("project_scope")

  const targets = [eq(handoffs.toUserId, c.var.userId)]
  if (agentSessionId) targets.push(eq(handoffs.toAgentSessionId, agentSessionId))
  if (includeBroadcast) targets.push(and(isNull(handoffs.toAgentSessionId), isNull(handoffs.toUserId))!)

  const conditions = [eq(handoffs.status, "pending"), or(...targets)!]
  if (projectScope) conditions.push(eq(handoffs.projectScope, projectScope))

  const rows = await c.var.db
    .select()
    .from(handoffs)
    .where(and(...conditions))
    .orderBy(desc(handoffs.createdAt))
    .limit(50)
  return c.json({ handoffs: rows.map(toHandoff) })
})

// POST /handoffs/accept — body: { handoff_id, agent_session_id? }
handoffRoutes.post("/accept", async (c) => {
  const body = await c.req.json<{ handoff_id?: unknown; agent_session_id?: unknown }>()
  if (typeof body.handoff_id !== "string" || !body.handoff_id)
    return c.json({ error: "invalid_body", detail: "handoff_id required" }, 400)
  const set: Partial<typeof handoffs.$inferInsert> = { status: "accepted", acceptedAt: new Date() }
  if (typeof body.agent_session_id === "string") set.toAgentSessionId = body.agent_session_id
  const updated = await c.var.db
    .update(handoffs)
    .set(set)
    .where(and(eq(handoffs.id, body.handoff_id), eq(handoffs.status, "pending")))
    .returning()
  if (!updated[0]) return c.json({ error: "not_found_or_not_pending" }, 404)
  await writeAudit(c.var.db, "handoff.accept", c.var.userId, set.toAgentSessionId ?? null, { handoff_id: body.handoff_id })
  return c.json({ handoff: toHandoff(updated[0]) })
})

// POST /handoffs/complete — body: { handoff_id, outcome? }
handoffRoutes.post("/complete", async (c) => {
  const body = await c.req.json<{ handoff_id?: unknown; outcome?: unknown }>()
  if (typeof body.handoff_id !== "string" || !body.handoff_id)
    return c.json({ error: "invalid_body", detail: "handoff_id required" }, 400)
  const updated = await c.var.db
    .update(handoffs)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(handoffs.id, body.handoff_id))
    .returning()
  if (!updated[0]) return c.json({ error: "not_found" }, 404)
  await writeAudit(c.var.db, "handoff.complete", c.var.userId, null, { handoff_id: body.handoff_id, outcome: typeof body.outcome === "string" ? body.outcome : null })
  return c.json({ handoff: toHandoff(updated[0]) })
})

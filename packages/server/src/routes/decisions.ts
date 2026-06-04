import { type DecisionType, pgSchema, toDecision } from "@continuity/shared"
import { and, desc, eq, gt } from "drizzle-orm"
import { Hono } from "hono"
import { writeAudit } from "../events.js"
import type { AppEnv } from "../types.js"

const { decisions } = pgSchema
const TYPES = ["architecture", "tooling", "process", "scope", "other"] as const

export const decisionRoutes = new Hono<AppEnv>()

// POST /decisions/write — 409 with the conflicting decision if an active one
// already shares decision_key and `supersedes` wasn't provided.
decisionRoutes.post("/write", async (c) => {
  const body = await c.req.json<{
    decision_key?: unknown
    content?: unknown
    decision_type?: unknown
    project_scope?: unknown
    author_agent_session_id?: unknown
    supersedes?: unknown
  }>()
  if (typeof body.decision_key !== "string" || !body.decision_key)
    return c.json({ error: "invalid_body", detail: "decision_key required" }, 400)
  if (typeof body.content !== "string" || !body.content)
    return c.json({ error: "invalid_body", detail: "content required" }, 400)
  const decisionType: DecisionType = TYPES.includes(body.decision_type as DecisionType)
    ? (body.decision_type as DecisionType)
    : "other"
  const projectScope = typeof body.project_scope === "string" ? body.project_scope : null
  const supersedes = typeof body.supersedes === "string" ? body.supersedes : null
  const authorSession = typeof body.author_agent_session_id === "string" ? body.author_agent_session_id : null

  const existingActive = await c.var.db
    .select()
    .from(decisions)
    .where(and(eq(decisions.decisionKey, body.decision_key), eq(decisions.status, "active")))
    .orderBy(desc(decisions.createdAt))
    .limit(1)
  if (existingActive[0] && !supersedes)
    return c.json({ error: "decision_conflict", existing: toDecision(existingActive[0]) }, 409)

  const insert = c.var.db
    .insert(decisions)
    .values({
      decisionKey: body.decision_key,
      content: body.content,
      decisionType,
      projectScope,
      authorUserId: c.var.userId,
      authorAgentSessionId: authorSession,
      status: "active",
      supersedes,
    })
    .returning()

  // neon-http is stateless and does NOT support interactive transactions, but
  // db.batch([...]) runs all statements in a single atomic transaction over the
  // HTTP wire. When superseding, mark the old row + insert the replacement in
  // one batch so we never leave a decision superseded with no active successor.
  let inserted: Awaited<typeof insert>
  if (supersedes) {
    const [, insertRes] = await c.var.db.batch([
      c.var.db.update(decisions).set({ status: "superseded" }).where(eq(decisions.id, supersedes)),
      insert,
    ])
    inserted = insertRes
  } else {
    inserted = await insert
  }
  await writeAudit(c.var.db, supersedes ? "decision.supersede" : "decision.write", c.var.userId, authorSession, {
    decision_key: body.decision_key,
    supersedes,
  })
  return c.json({ decision: toDecision(inserted[0]!) })
})

// GET /decisions/recent?since=&scope=&limit=
decisionRoutes.get("/recent", async (c) => {
  const since = c.req.query("since")
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const scope = c.req.query("scope")
  const limit = Math.min(Number(c.req.query("limit") ?? "25") || 25, 100)
  const conditions = [gt(decisions.createdAt, sinceDate), eq(decisions.status, "active")]
  if (scope) conditions.push(eq(decisions.projectScope, scope))
  const rows = await c.var.db
    .select()
    .from(decisions)
    .where(and(...conditions))
    .orderBy(desc(decisions.createdAt))
    .limit(limit)
  return c.json({ decisions: rows.map(toDecision) })
})

// GET /decisions/get_by_key?key=&scope=
decisionRoutes.get("/get_by_key", async (c) => {
  const key = c.req.query("key")
  if (!key) return c.json({ error: "invalid_query", detail: "key required" }, 400)
  const scope = c.req.query("scope")
  const conditions = [eq(decisions.decisionKey, key), eq(decisions.status, "active")]
  if (scope) conditions.push(eq(decisions.projectScope, scope))
  const rows = await c.var.db
    .select()
    .from(decisions)
    .where(and(...conditions))
    .orderBy(desc(decisions.createdAt))
    .limit(1)
  return c.json({ decision: rows[0] ? toDecision(rows[0]) : null })
})

// POST /decisions/supersede — body: { existing_id, new_content, reason?, author_agent_session_id? }
decisionRoutes.post("/supersede", async (c) => {
  const body = await c.req.json<{
    existing_id?: unknown
    new_content?: unknown
    reason?: unknown
    author_agent_session_id?: unknown
  }>()
  if (typeof body.existing_id !== "string" || !body.existing_id)
    return c.json({ error: "invalid_body", detail: "existing_id required" }, 400)
  if (typeof body.new_content !== "string" || !body.new_content)
    return c.json({ error: "invalid_body", detail: "new_content required" }, 400)
  const authorSession = typeof body.author_agent_session_id === "string" ? body.author_agent_session_id : null

  const existing = await c.var.db.select().from(decisions).where(eq(decisions.id, body.existing_id)).limit(1)
  const old = existing[0]
  if (!old) return c.json({ error: "not_found" }, 404)

  // neon-http has no interactive transactions, but db.batch([...]) commits all
  // statements atomically over a single HTTP round-trip. Supersede the old row
  // and insert the replacement together so a failure can't strand the old
  // decision as superseded with no active successor.
  const [, inserted] = await c.var.db.batch([
    c.var.db.update(decisions).set({ status: "superseded" }).where(eq(decisions.id, old.id)),
    c.var.db
      .insert(decisions)
      .values({
        decisionKey: old.decisionKey,
        content: body.new_content,
        decisionType: old.decisionType,
        projectScope: old.projectScope,
        authorUserId: c.var.userId,
        authorAgentSessionId: authorSession,
        status: "active",
        supersedes: old.id,
      })
      .returning(),
  ])
  await writeAudit(c.var.db, "decision.supersede", c.var.userId, authorSession, {
    decision_key: old.decisionKey,
    existing_id: old.id,
    reason: typeof body.reason === "string" ? body.reason : null,
  })
  return c.json({ decision: toDecision(inserted[0]!) })
})

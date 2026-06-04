import { derivedStatus, pgSchema, toActiveSession, toRecentFileActivity, toSessionDetail } from "@continuity/shared"
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm"
import { Hono } from "hono"
import { writeAudit } from "../events.js"
import type { AppEnv } from "../types.js"

const { agentSessions, fileActivity, users } = pgSchema

export const agentRoutes = new Hono<AppEnv>()

// POST /agent/checkin — idempotent on (user, cwd) via the partial unique index.
// `xmax = 0` is true only for a freshly inserted tuple, so we report `reused`
// and emit the checkin audit only for genuinely new sessions, in one round-trip.
agentRoutes.post("/checkin", async (c) => {
  const body = await c.req.json<{
    agent_label?: unknown
    cwd_hash?: unknown
    project_scope?: unknown
    current_focus?: unknown
  }>()
  if (typeof body.agent_label !== "string" || !body.agent_label)
    return c.json({ error: "invalid_body", detail: "agent_label required" }, 400)
  if (typeof body.cwd_hash !== "string" || !body.cwd_hash)
    return c.json({ error: "invalid_body", detail: "cwd_hash required" }, 400)
  const projectScope = typeof body.project_scope === "string" ? body.project_scope : null
  const currentFocus = typeof body.current_focus === "string" ? body.current_focus : null
  const now = new Date()

  const upserted = await c.var.db
    .insert(agentSessions)
    .values({
      userId: c.var.userId,
      agentLabel: body.agent_label,
      cwdHash: body.cwd_hash,
      projectScope,
      currentFocus,
      status: "active",
      startedAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [agentSessions.userId, agentSessions.cwdHash],
      targetWhere: sql`status <> 'gone'`,
      set: { agentLabel: body.agent_label, projectScope, currentFocus, status: "active", lastSeenAt: now, endedAt: null },
    })
    .returning({ id: agentSessions.id, isNew: sql<boolean>`(xmax = 0)` })

  const row = upserted[0]!
  if (row.isNew) await writeAudit(c.var.db, "agent.checkin", c.var.userId, row.id, { cwd_hash: body.cwd_hash })
  return c.json({ session_id: row.id, reused: !row.isNew })
})

// POST /agent/heartbeat — body: { session_id, current_focus? }
agentRoutes.post("/heartbeat", async (c) => {
  const body = await c.req.json<{ session_id?: unknown; current_focus?: unknown }>()
  if (typeof body.session_id !== "string" || !body.session_id)
    return c.json({ error: "invalid_body", detail: "session_id required" }, 400)
  const set: { lastSeenAt: Date; status: "active"; currentFocus?: string } = { lastSeenAt: new Date(), status: "active" }
  if (typeof body.current_focus === "string") set.currentFocus = body.current_focus
  const updated = await c.var.db
    .update(agentSessions)
    .set(set)
    .where(and(eq(agentSessions.id, body.session_id), eq(agentSessions.userId, c.var.userId)))
    .returning({ id: agentSessions.id })
  if (!updated[0]) return c.json({ error: "not_found" }, 404)
  return c.json({ ok: true })
})

// POST /agent/checkout — body: { session_id, reason? }
agentRoutes.post("/checkout", async (c) => {
  const body = await c.req.json<{ session_id?: unknown; reason?: unknown }>()
  if (typeof body.session_id !== "string" || !body.session_id)
    return c.json({ error: "invalid_body", detail: "session_id required" }, 400)
  const now = new Date()
  const updated = await c.var.db
    .update(agentSessions)
    .set({ status: "gone", endedAt: now, lastSeenAt: now })
    .where(and(eq(agentSessions.id, body.session_id), eq(agentSessions.userId, c.var.userId)))
    .returning({ id: agentSessions.id })
  if (!updated[0]) return c.json({ error: "not_found" }, 404)
  await writeAudit(c.var.db, "agent.checkout", c.var.userId, body.session_id, {
    reason: typeof body.reason === "string" ? body.reason : null,
  })
  return c.json({ ok: true })
})

// GET /agent/list_active?project_scope=&max_age_seconds=&exclude_session=
agentRoutes.get("/list_active", async (c) => {
  const maxAge = Number(c.req.query("max_age_seconds") ?? "300")
  const windowSeconds = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 300
  const cutoff = new Date(Date.now() - windowSeconds * 1000)
  const projectScope = c.req.query("project_scope")
  const excludeSession = c.req.query("exclude_session")

  const conditions = [inArray(agentSessions.status, ["active", "idle"]), gt(agentSessions.lastSeenAt, cutoff)]
  if (projectScope) conditions.push(eq(agentSessions.projectScope, projectScope))
  if (excludeSession) conditions.push(ne(agentSessions.id, excludeSession))

  const rows = await c.var.db
    .select({ session: agentSessions, userName: users.name })
    .from(agentSessions)
    .innerJoin(users, eq(agentSessions.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(agentSessions.lastSeenAt))

  // The SQL pre-filter (status in active|idle, last_seen within window) is a
  // coarse filter. Derive the effective status live from last_seen_at on top,
  // exactly as the local flavor does, so a heartbeat-stale session reports
  // "idle"/"gone" before the janitor cron flips the stored column. Drop rows
  // that derive to "gone" and emit the derived status.
  const sessions = rows
    .map((r) => ({ r, status: derivedStatus(r.session.lastSeenAt, r.session.status) }))
    .filter((x) => x.status !== "gone")
    .map((x) => toActiveSession({ ...x.r.session, status: x.status }, x.r.userName))

  return c.json({ sessions })
})

// GET /agent/get?id=<session_id>
agentRoutes.get("/get", async (c) => {
  const id = c.req.query("id")
  if (!id) return c.json({ error: "invalid_query", detail: "id required" }, 400)
  const rows = await c.var.db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1)
  const r = rows[0]
  return c.json({ session: r ? toSessionDetail(r) : null })
})

// POST /agent/file_activity — body: { session_id, repo_full_name?, files: [{ path, tool }] }
agentRoutes.post("/file_activity", async (c) => {
  const body = await c.req.json<{ session_id?: unknown; repo_full_name?: unknown; files?: unknown }>()
  if (typeof body.session_id !== "string" || !body.session_id)
    return c.json({ error: "invalid_body", detail: "session_id required" }, 400)
  if (!Array.isArray(body.files) || body.files.length === 0)
    return c.json({ error: "invalid_body", detail: "files[] required" }, 400)
  const repoFullName = typeof body.repo_full_name === "string" ? body.repo_full_name : null

  const owner = await c.var.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, body.session_id), eq(agentSessions.userId, c.var.userId)))
    .limit(1)
  if (!owner[0]) return c.json({ error: "not_found" }, 404)

  const allowedTools = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const
  const now = new Date()
  const values: (typeof fileActivity.$inferInsert)[] = []
  for (const f of body.files as Array<{ path?: unknown; tool?: unknown }>) {
    if (typeof f.path !== "string" || !f.path) continue
    const tool = allowedTools.find((t) => t === f.tool)
    if (!tool) continue
    values.push({ agentSessionId: body.session_id, userId: c.var.userId, filePath: f.path, repoFullName, tool, touchedAt: now })
  }
  if (values.length === 0) return c.json({ error: "invalid_body", detail: "no valid files" }, 400)

  await c.var.db
    .insert(fileActivity)
    .values(values)
    .onConflictDoUpdate({
      target: [fileActivity.agentSessionId, fileActivity.filePath],
      set: { tool: sql`excluded.tool`, repoFullName: sql`excluded.repo_full_name`, touchedAt: sql`excluded.touched_at` },
    })
  return c.json({ ok: true, count: values.length })
})

// GET /agent/file_activity/recent?since_seconds=&exclude_session=&path_prefix=&limit=
agentRoutes.get("/file_activity/recent", async (c) => {
  const sinceSeconds = Number(c.req.query("since_seconds") ?? "1800")
  const windowSeconds = Number.isFinite(sinceSeconds) && sinceSeconds > 0 ? sinceSeconds : 1800
  const cutoff = new Date(Date.now() - windowSeconds * 1000)
  const excludeSession = c.req.query("exclude_session")
  const pathPrefix = c.req.query("path_prefix")
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200)

  const conditions = [gt(fileActivity.touchedAt, cutoff)]
  if (excludeSession) conditions.push(ne(fileActivity.agentSessionId, excludeSession))
  if (pathPrefix) conditions.push(sql`${fileActivity.filePath} LIKE ${`${pathPrefix}%`}`)

  const rows = await c.var.db
    .select({ activity: fileActivity, agentLabel: agentSessions.agentLabel, userName: users.name })
    .from(fileActivity)
    .innerJoin(agentSessions, eq(fileActivity.agentSessionId, agentSessions.id))
    .innerJoin(users, eq(fileActivity.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(fileActivity.touchedAt))
    .limit(limit)

  return c.json({
    activity: rows.map((r) => toRecentFileActivity(r.activity, { agentLabel: r.agentLabel, userName: r.userName })),
  })
})

// POST /agent/audit_event — body: { event_type, session_id?, payload? }
agentRoutes.post("/audit_event", async (c) => {
  const body = await c.req.json<{ event_type?: unknown; session_id?: unknown; payload?: unknown }>()
  if (typeof body.event_type !== "string" || !body.event_type)
    return c.json({ error: "invalid_body", detail: "event_type required" }, 400)
  await writeAudit(
    c.var.db,
    body.event_type,
    c.var.userId,
    typeof body.session_id === "string" ? body.session_id : null,
    body.payload,
  )
  return c.json({ ok: true })
})

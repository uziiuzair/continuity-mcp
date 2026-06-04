import { pgSchema, toAuditEvent } from "@continuity/shared"
import { and, desc, eq, gt } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "../types.js"

const { auditEvents } = pgSchema

export const auditRoutes = new Hono<AppEnv>()

// GET /audit/recent?since=&type=&limit=
auditRoutes.get("/recent", async (c) => {
  const since = c.req.query("since")
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const type = c.req.query("type")
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200)

  const conditions = [gt(auditEvents.createdAt, sinceDate)]
  if (type) conditions.push(eq(auditEvents.eventType, type))

  const rows = await c.var.db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)
  return c.json({ events: rows.map(toAuditEvent) })
})

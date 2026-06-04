import { pgSchema } from "@continuity/shared"
import { gt } from "drizzle-orm"
import { makeDb } from "./db.js"
import { postSlack } from "./slack.js"
import type { Bindings } from "./types.js"

const { auditEvents } = pgSchema

// Weekly aggregation of the audit log, posted to Slack. Triggered by the weekly
// cron; safe to call manually. Returns the rendered summary text. The Slack post
// is a no-op (postSlack returns false) when SLACK_WEBHOOK_URL is absent, so the
// digest still computes without crashing.
export async function runWeeklyDigest(env: Bindings): Promise<string> {
  const db = makeDb(env.DATABASE_URL)
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const rows = await db
    .select({ eventType: auditEvents.eventType })
    .from(auditEvents)
    .where(gt(auditEvents.createdAt, since))

  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.eventType, (counts.get(r.eventType) ?? 0) + 1)

  const interesting = [
    "task.claim",
    "task.complete",
    "pr.opened",
    "decision.write",
    "decision.supersede",
    "handoff.create",
    "escalation.posted",
  ]
  const lines = ["*Continuity weekly digest*", `_${since.toISOString().slice(0, 10)} → now_`, ""]
  for (const key of interesting) {
    const n = counts.get(key) ?? 0
    if (n > 0) lines.push(`• ${key}: ${n}`)
  }
  if (lines.length === 3) lines.push("• (no recorded activity this week)")
  const text = lines.join("\n")

  await postSlack(env, text)
  return text
}

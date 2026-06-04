import { Hono } from "hono"
import { writeAudit } from "../events.js"
import { postSlack } from "../slack.js"
import type { AppEnv } from "../types.js"

export const escalationRoutes = new Hono<AppEnv>()

// POST /escalation/post
// body: { agent_session_id?, reason, context, suggested_questions?, repo? }
// Always records an audit event via writeAudit. Posts to Slack when
// SLACK_WEBHOOK_URL is set; otherwise returns { slack_posted: false } and tells
// the caller to fall back to a `needs-human` GitHub issue.
escalationRoutes.post("/post", async (c) => {
  const body = await c.req.json<{
    agent_session_id?: unknown
    reason?: unknown
    context?: unknown
    suggested_questions?: unknown
    repo?: unknown
  }>()
  if (typeof body.reason !== "string" || !body.reason) {
    return c.json({ error: "invalid_body", detail: "reason required" }, 400)
  }
  const context = typeof body.context === "string" ? body.context : ""
  const sessionId = typeof body.agent_session_id === "string" ? body.agent_session_id : null
  const repo = typeof body.repo === "string" ? body.repo : null

  // Always record the escalation in the audit log (non-critical, never throws).
  await writeAudit(c.var.db, "escalation.posted", c.var.userId, sessionId, {
    reason: body.reason,
    context,
    repo,
    suggested_questions: body.suggested_questions ?? null,
  })

  const text =
    `:rotating_light: *Continuity escalation*\n*Reason:* ${body.reason}\n` +
    (context ? `*Context:* ${context}\n` : "") +
    (repo ? `*Repo:* ${repo}\n` : "")
  const slackOk = await postSlack(c.env, text)

  return c.json({
    slack_posted: slackOk,
    // When Slack didn't go through, the agent should open a needs-human issue.
    fallback: slackOk ? null : "open_needs_human_issue",
  })
})

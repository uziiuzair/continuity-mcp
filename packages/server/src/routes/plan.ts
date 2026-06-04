import { Hono } from "hono"
import { writeAudit } from "../events.js"
import { planCheck } from "../plan-check.js"
import type { AppEnv } from "../types.js"

export const planRoutes = new Hono<AppEnv>()

// POST /plan/check — body: { task_description, repo?, agent_session_id?, bypass? }
// Returns the phase verdict. `bypass: true` short-circuits the check but is
// loudly audited so it shows up in the digest. When ANTHROPIC_API_KEY is absent
// planCheck returns a permissive { in_phase: true } so it never blocks.
planRoutes.post("/check", async (c) => {
  const body = await c.req.json<{
    task_description?: unknown
    repo?: unknown
    agent_session_id?: unknown
    bypass?: unknown
  }>()
  if (typeof body.task_description !== "string" || !body.task_description) {
    return c.json({ error: "invalid_body", detail: "task_description required" }, 400)
  }
  const repo = typeof body.repo === "string" ? body.repo : undefined
  const sessionId = typeof body.agent_session_id === "string" ? body.agent_session_id : null

  if (body.bypass === true) {
    await writeAudit(c.var.db, "plan.bypass", c.var.userId, sessionId, {
      task_description: body.task_description,
      repo,
    })
    return c.json({
      in_phase: true,
      current_phase: null,
      rationale: "plan_check bypassed by request (audited).",
      suggested_action: null,
      bypassed: true,
    })
  }

  const result = await planCheck(c.env, body.task_description, repo)
  if (!result.in_phase) {
    await writeAudit(c.var.db, "plan.out_of_phase", c.var.userId, sessionId, {
      task_description: body.task_description,
      repo,
      current_phase: result.current_phase,
    })
  }
  return c.json(result)
})

// GET /plan/current?repo= — current phase context (runs a lightweight check
// with an empty task so we get the model's read of the current phase).
planRoutes.get("/current", async (c) => {
  const repo = c.req.query("repo")
  const result = await planCheck(c.env, "(no task — report the current phase only)", repo)
  return c.json({ current_phase: result.current_phase, rationale: result.rationale })
})

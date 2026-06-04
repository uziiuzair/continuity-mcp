import { Hono } from "hono"
import { cors } from "hono/cors"
import { requireApiKey } from "./auth.js"
import { agentRoutes } from "./routes/agent.js"
import { auditRoutes } from "./routes/audit.js"
import { decisionRoutes } from "./routes/decisions.js"
import { escalationRoutes } from "./routes/escalation.js"
import { githubRoutes } from "./routes/github.js"
import { handoffRoutes } from "./routes/handoffs.js"
import { planRoutes } from "./routes/plan.js"
import { taskRoutes } from "./routes/tasks.js"
import { handleScheduled } from "./scheduled.js"
import type { AppEnv, Bindings } from "./types.js"

const app = new Hono<AppEnv>()

// MCP shims and plugin hooks call from arbitrary local origins. The Bearer API
// key is the real security boundary; open CORS is intentional.
app.use("*", cors())

app.get("/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT ?? "production" }))

// One mount helper keeps the Bearer-auth wiring uniform across surfaces.
function authed(path: string, routes: Hono<AppEnv>): void {
  const sub = new Hono<AppEnv>()
  sub.use("*", requireApiKey)
  sub.route("/", routes)
  app.route(path, sub)
}

authed("/agent", agentRoutes)
authed("/decisions", decisionRoutes)
authed("/tasks", taskRoutes)
authed("/handoffs", handoffRoutes)
authed("/audit", auditRoutes)
// Team-flavor extras (GitHub Projects sync, plan-check, Slack escalation). Each
// external integration is optional and degrades gracefully when its secret is
// absent (see the respective routes), so these mount unconditionally.
authed("/github", githubRoutes)
authed("/plan", planRoutes)
authed("/escalation", escalationRoutes)

app.notFound((c) => c.json({ error: "not_found" }, 404))
app.onError((err, c) => {
  console.error("[continuity-server] unhandled", err)
  return c.json({ error: "internal_error" }, 500)
})

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Bindings>

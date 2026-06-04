import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { type TeamToolContext, asText } from "./util.js"

// Plan/phase awareness and escalation (team flavor only). The Worker owns the
// phase config and the escalation channel (Slack / needs-human issue fallback).
export function registerPlanTools(server: McpServer, ctx: TeamToolContext): void {
  const repoDefault = ctx.repoFullName ?? undefined

  server.registerTool(
    "plan_check",
    {
      title: "Check a task against the current phase",
      description:
        "Before starting non-trivial work, check whether it fits the repo's current development phase. If it returns in_phase=false, surface the rationale to the user rather than pressing ahead. Set bypass=true only for clearly trivial work (it's audited).",
      inputSchema: {
        task_description: z.string(),
        repo: z.string().optional(),
        bypass: z.boolean().optional(),
      },
    },
    async (args) =>
      asText(
        await ctx.team.planCheck({
          task_description: args.task_description,
          repo: args.repo ?? repoDefault,
          bypass: args.bypass,
          agent_session_id: ctx.getSessionId() ?? undefined,
        }),
      ),
  )

  server.registerTool(
    "plan_current",
    {
      title: "Current development phase",
      description: "Report the repo's current development phase context.",
      inputSchema: { repo: z.string().optional() },
    },
    async (args) => asText(await ctx.team.planCurrent({ repo: args.repo ?? repoDefault })),
  )

  server.registerTool(
    "escalate",
    {
      title: "Escalate to a human",
      description:
        "Escalate a blocker that needs a human decision. Posts to the team's escalation channel (or signals a needs-human GitHub issue fallback). Use when you're genuinely blocked, not for routine questions.",
      inputSchema: {
        reason: z.string(),
        context: z.string(),
        suggested_questions: z.string().optional(),
        repo: z.string().optional(),
      },
    },
    async (args) =>
      asText(
        await ctx.team.escalate({
          reason: args.reason,
          context: args.context,
          suggested_questions: args.suggested_questions,
          repo: args.repo ?? repoDefault,
          agent_session_id: ctx.getSessionId() ?? undefined,
        }),
      ),
  )
}

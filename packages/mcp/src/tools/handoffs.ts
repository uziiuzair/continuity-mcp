import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { type ToolContext, asText } from "./util.js"

// Structured context transfers between sessions (or session -> human).
export function registerHandoffTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "handoff_create",
    {
      title: "Create a handoff",
      description:
        "Hand off work to another session or broadcast it. Use when you're stopping mid-task, hitting something out of your lane, or another session is better placed to continue. Include enough state (branch, files, next actions) for a clean pickup.",
      inputSchema: {
        to_session_id: z.string().optional(),
        project_scope: z.string().optional(),
        context: z.string(),
        state: z.string().optional().describe("Serialized JSON: branch, files touched, links."),
        suggested_next_actions: z.string().optional(),
      },
    },
    async (args) => {
      const from = ctx.getSessionId()
      if (!from) return asText({ ok: false, reason: "no_active_session" })
      return asText(await ctx.backend.handoffCreate({ ...args, from_session_id: from }))
    },
  )

  server.registerTool(
    "handoff_pending",
    {
      title: "Pending handoffs for you",
      description:
        "List handoffs waiting for you (this session or broadcasts). Check at task start — a pending handoff may already cover what you're about to do.",
      inputSchema: {
        include_broadcast: z.boolean().optional(),
        project_scope: z.string().optional(),
      },
    },
    async (args) =>
      asText(
        await ctx.backend.handoffPending({
          agent_session_id: ctx.getSessionId() ?? undefined,
          include_broadcast: args.include_broadcast,
          project_scope: args.project_scope,
        }),
      ),
  )

  server.registerTool(
    "handoff_accept",
    {
      title: "Accept a handoff",
      description: "Accept a pending handoff, taking ownership of the work it describes.",
      inputSchema: { handoff_id: z.string() },
    },
    async (args) =>
      asText(
        await ctx.backend.handoffAccept({
          ...args,
          agent_session_id: ctx.getSessionId() ?? undefined,
        }),
      ),
  )

  server.registerTool(
    "handoff_complete",
    {
      title: "Complete a handoff",
      description: "Mark a handoff complete once you've finished the handed-off work.",
      inputSchema: { handoff_id: z.string(), outcome: z.string().optional() },
    },
    async (args) => asText(await ctx.backend.handoffComplete(args)),
  )
}

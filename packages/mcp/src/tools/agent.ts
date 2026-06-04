import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { type ToolContext, asText } from "./util.js"

// Phase-1 model-facing tools are read + focus only. Lifecycle (checkin,
// heartbeat, checkout) and file-activity reporting are driven automatically by
// the shim and the plugin hooks, not by the model.
export function registerAgentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "agent_list_active",
    {
      title: "List active Continuity sessions",
      description:
        "List other Claude Code sessions currently working in this repo/project (presence + what they're focused on). Call this before starting substantive work to avoid duplicating what another session is already doing.",
      inputSchema: {
        max_age_seconds: z
          .number()
          .optional()
          .describe("Only include sessions seen within this window. Default 300."),
        project_scope: z.string().optional(),
      },
    },
    async ({ max_age_seconds, project_scope }) =>
      asText(
        await ctx.backend.listActive({
          max_age_seconds,
          project_scope,
          exclude_session: ctx.getSessionId() ?? undefined,
        }),
      ),
  )

  server.registerTool(
    "agent_file_activity_recent",
    {
      title: "Recent files other sessions are touching",
      description:
        "Show which files other active sessions have edited recently. Call this before editing a file to check whether another agent is already working in it — if it overlaps, coordinate or hand off instead of editing in parallel.",
      inputSchema: {
        since_seconds: z
          .number()
          .optional()
          .describe("Lookback window in seconds. Default 1800 (30m)."),
        path_prefix: z
          .string()
          .optional()
          .describe("Restrict to files under this repo-relative prefix."),
        limit: z.number().optional(),
      },
    },
    async ({ since_seconds, path_prefix, limit }) =>
      asText(
        await ctx.backend.recentFileActivity({
          since_seconds,
          path_prefix,
          limit,
          exclude_session: ctx.getSessionId() ?? undefined,
        }),
      ),
  )

  server.registerTool(
    "agent_get",
    {
      title: "Get a Continuity session by id",
      description: "Fetch full details of a specific agent session by its session_id.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => asText(await ctx.backend.getSession(session_id)),
  )

  server.registerTool(
    "agent_report_focus",
    {
      title: "Report what you're working on",
      description:
        "Update this session's current focus so other sessions can see what you're doing. Call this when you start a distinct piece of work.",
      inputSchema: { current_focus: z.string() },
    },
    async ({ current_focus }) => {
      const sessionId = ctx.getSessionId()
      if (!sessionId) return asText({ ok: false, reason: "no_active_session" })
      await ctx.backend.heartbeat({ session_id: sessionId, current_focus })
      return asText({ ok: true })
    },
  )
}

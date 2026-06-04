import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { type ToolContext, asText } from "./util.js"

// Typed shared decisions. Writing a decision under a key that already has an
// active decision returns a conflict (surfaced here, not thrown) so the agent
// explicitly chooses to supersede or back off.
export function registerDecisionTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "decision_write",
    {
      title: "Record a shared decision",
      description:
        "Record a decision other sessions must respect (architecture, tooling, process, scope). If an active decision already exists under the same key you'll get a conflict — resolve it by superseding or backing off. Use this whenever you make a call others must follow.",
      inputSchema: {
        decision_key: z.string().describe("Stable topic key, e.g. 'auth.session-store'."),
        content: z.string(),
        decision_type: z.enum(["architecture", "tooling", "process", "scope", "other"]).optional(),
        project_scope: z.string().optional(),
        supersedes: z.string().optional().describe("Decision id this replaces (resolves a conflict)."),
      },
    },
    async (args) =>
      asText(
        await ctx.backend.decisionWrite({
          ...args,
          author_agent_session_id: ctx.getSessionId() ?? undefined,
        }),
      ),
  )

  server.registerTool(
    "decision_recent",
    {
      title: "Recent shared decisions",
      description:
        "List recent active decisions. Call at the start of a task to load current calls before you make conflicting choices.",
      inputSchema: {
        since: z.string().optional(),
        scope: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async (args) => asText(await ctx.backend.decisionRecent(args)),
  )

  server.registerTool(
    "decision_get_by_key",
    {
      title: "Get the current decision for a key",
      description: "Fetch the current active decision for a topic key, if any.",
      inputSchema: { key: z.string(), scope: z.string().optional() },
    },
    async (args) => asText(await ctx.backend.decisionGetByKey(args)),
  )

  server.registerTool(
    "decision_supersede",
    {
      title: "Supersede a decision",
      description:
        "Replace an existing decision with new content. Use this to resolve a decision conflict or to update a call previously made.",
      inputSchema: {
        existing_id: z.string(),
        new_content: z.string(),
        reason: z.string().optional(),
      },
    },
    async (args) =>
      asText(
        await ctx.backend.decisionSupersede({
          ...args,
          author_agent_session_id: ctx.getSessionId() ?? undefined,
        }),
      ),
  )
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { type ToolContext, asText } from "./util.js"

// Soft task claims. The claim makes "I've started this" visible immediately; a
// conflict means another session got there first.
export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "task_claim",
    {
      title: "Claim a task",
      description:
        "Claim an issue/task at the coordination layer so other sessions don't duplicate it. A conflict means it's already claimed — pick another task or coordinate.",
      inputSchema: {
        repo_full_name: z.string(),
        issue_number: z.number(),
        notes: z.string().optional(),
      },
    },
    async (args) =>
      asText(
        await ctx.backend.taskClaim({
          ...args,
          agent_session_id: ctx.getSessionId() ?? undefined,
        }),
      ),
  )

  server.registerTool(
    "task_update",
    {
      title: "Update a task claim",
      description: "Update a claim's status/notes/PR number. Bumps its activity timestamp.",
      inputSchema: {
        claim_id: z.string(),
        status: z.enum(["claimed", "in_progress", "pr_open", "released", "completed"]).optional(),
        pr_number: z.number().optional(),
        notes: z.string().optional(),
      },
    },
    async (args) => asText(await ctx.backend.taskUpdate(args)),
  )

  server.registerTool(
    "task_release",
    {
      title: "Release a task claim",
      description: "Release a claim so another session can pick it up.",
      inputSchema: { claim_id: z.string(), reason: z.string().optional() },
    },
    async (args) => asText(await ctx.backend.taskRelease(args)),
  )

  server.registerTool(
    "task_complete",
    {
      title: "Complete a task claim",
      description: "Mark a claim complete (e.g. after the PR merges).",
      inputSchema: { claim_id: z.string(), outcome: z.string().optional() },
    },
    async (args) => asText(await ctx.backend.taskComplete(args)),
  )

  server.registerTool(
    "task_list",
    {
      title: "List task claims",
      description: "List current task claims, optionally filtered by status or repo.",
      inputSchema: {
        status: z.enum(["claimed", "in_progress", "pr_open", "released", "completed"]).optional(),
        scope: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async (args) => asText(await ctx.backend.taskList(args)),
  )
}

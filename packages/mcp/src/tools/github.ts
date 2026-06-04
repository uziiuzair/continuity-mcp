import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { type TeamToolContext, asText } from "./util.js"

// GitHub Projects integration (team flavor only). The Worker brokers all GitHub
// access; claiming an issue assigns the *human* who owns this agent, not the
// agent itself.
export function registerGithubTools(server: McpServer, ctx: TeamToolContext): void {
  const repoDefault = ctx.repoFullName ?? undefined

  server.registerTool(
    "github_list_projects",
    {
      title: "List GitHub Projects",
      description: "List the GitHub Projects (v2) boards for a repo (cached server-side).",
      inputSchema: { repo: z.string().optional() },
    },
    async (args) => asText(await ctx.team.githubListProjects({ repo: args.repo ?? repoDefault })),
  )

  server.registerTool(
    "github_list_open_issues",
    {
      title: "List open issues",
      description:
        "List open issues for a repo, annotated with any existing claim. Use this to find unclaimed work that matches your task before you start.",
      inputSchema: {
        repo: z.string().optional(),
        label: z.string().optional(),
        assigned_to_me: z.boolean().optional(),
      },
    },
    async (args) =>
      asText(
        await ctx.team.githubListOpenIssues({
          repo: args.repo ?? repoDefault,
          label: args.label,
          assigned_to_me: args.assigned_to_me,
        }),
      ),
  )

  server.registerTool(
    "github_claim_issue",
    {
      title: "Claim a GitHub issue (and assign the human)",
      description:
        "Claim an issue before you start substantive work on it: records the claim, assigns the human who owns this session on GitHub, and sets the board Status to In Progress. A conflict means it's already claimed — pick another issue. Do this BEFORE editing so other agents don't duplicate the work.",
      inputSchema: { repo: z.string().optional(), issue_number: z.number() },
    },
    async (args) =>
      asText(
        await ctx.team.githubClaimIssue({
          repo: args.repo ?? repoDefault,
          issue_number: args.issue_number,
          agent_session_id: ctx.getSessionId() ?? undefined,
        }),
      ),
  )

  server.registerTool(
    "github_open_pr",
    {
      title: "Open a pull request",
      description:
        "Open a PR for the current work, linking it to the claimed issue and updating the claim to pr_open.",
      inputSchema: {
        repo: z.string().optional(),
        issue_number: z.number(),
        branch: z.string(),
        title: z.string(),
        body: z.string(),
      },
    },
    async (args) =>
      asText(
        await ctx.team.githubOpenPr({
          repo: args.repo ?? repoDefault,
          issue_number: args.issue_number,
          branch: args.branch,
          title: args.title,
          body: args.body,
        }),
      ),
  )

  server.registerTool(
    "github_update_status",
    {
      title: "Update issue board status",
      description: "Set an issue's Project board Status field (e.g. 'In Review', 'Done').",
      inputSchema: {
        repo: z.string().optional(),
        issue_number: z.number(),
        new_status: z.string(),
        notes: z.string().optional(),
      },
    },
    async (args) =>
      asText(
        await ctx.team.githubUpdateStatus({
          repo: args.repo ?? repoDefault,
          issue_number: args.issue_number,
          new_status: args.new_status,
          notes: args.notes,
        }),
      ),
  )
}

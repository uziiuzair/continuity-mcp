import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { MESSAGE_STATUSES } from "@continuity/shared"
import { z } from "zod"
import { readState, writeState } from "../state.js"
import { type ToolContext, asText, messageTimeoutMinutes } from "./util.js"

// Direct messages between sessions. Sending with about_file marks collision
// coordination and stamps the state file so the PreToolUse guard tracks it;
// responding/dismissing prunes the pending-inbound cache so the ack/stop gates
// release without waiting for the next prompt-sync.
export function registerMessageTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "message_send",
    {
      title: "Send a message to another session",
      description:
        "Message another live session (to_session) or broadcast to all. Set about_file (repo-relative path) when coordinating a file collision — the edit block on that file lifts when they respond or the message expires. Delivery: the recipient sees it on their next prompt. Provide exactly one of to_session or broadcast.",
      inputSchema: {
        to_session: z.string().optional(),
        broadcast: z.boolean().optional(),
        body: z.string(),
        requires_response: z.boolean().optional(),
        about_file: z.string().optional().describe("Repo-relative path of a contested file."),
      },
    },
    async (args) => {
      const from = ctx.getSessionId()
      if (!from) return asText({ ok: false, reason: "no_active_session" })
      // truthiness XOR: exactly one of to_session/broadcast ("" and false both read as unset)
      if (!args.to_session === !args.broadcast)
        return asText({ ok: false, reason: "exactly one of to_session / broadcast required" })
      const result = await ctx.backend.messageSend({
        from_session: from,
        to_session: args.to_session,
        broadcast: args.broadcast,
        kind: args.about_file ? "collision" : "message",
        body: args.body,
        requires_response: args.about_file ? true : (args.requires_response ?? false),
        related_key: args.about_file ?? null,
        repo_full_name: ctx.repoFullName,
        expires_in_minutes: messageTimeoutMinutes(),
      })
      if (args.about_file && result.message_ids[0]) {
        const state = readState(ctx.cwdHash)
        if (state) {
          writeState(ctx.cwdHash, {
            ...state,
            collision_sent: {
              ...(state.collision_sent ?? {}),
              [args.about_file]: {
                message_id: result.message_ids[0],
                expires_at: result.expires_at,
                status: "pending",
              },
            },
          })
        }
      }
      return asText(result)
    },
  )

  server.registerTool(
    "message_list",
    {
      title: "List your messages",
      description: "Inbox/outbox for this session, optionally filtered by direction or status.",
      inputSchema: {
        direction: z.enum(["inbound", "outbound"]).optional(),
        status: z.enum(MESSAGE_STATUSES).optional(),
        limit: z.number().optional(),
      },
    },
    async (args) => {
      const session = ctx.getSessionId()
      if (!session) return asText({ ok: false, reason: "no_active_session" })
      return asText(await ctx.backend.messageList({ ...args, session_id: session }))
    },
  )

  // Respond/dismiss share the resolution path: mark the row, then prune the
  // local pending-inbound cache so the ack/stop gates release this turn.
  const resolveLocally = (messageId: string): void => {
    const state = readState(ctx.cwdHash)
    if (!state) return
    writeState(ctx.cwdHash, {
      ...state,
      pending_inbound: (state.pending_inbound ?? []).filter((m) => m.message_id !== messageId),
    })
  }

  server.registerTool(
    "message_respond",
    {
      title: "Respond to a message",
      description:
        "Answer a pending message (also how you ack a decision). Clears any edit/turn-end gate it was holding.",
      inputSchema: { message_id: z.string(), response: z.string() },
    },
    async (args) => {
      const result = await ctx.backend.messageRespond(args)
      if (result.ok) resolveLocally(args.message_id)
      return asText(result)
    },
  )

  server.registerTool(
    "message_dismiss",
    {
      title: "Dismiss a message",
      description:
        "Explicitly decline to respond, with a reason (auditable). Clears gates the same as responding.",
      inputSchema: { message_id: z.string(), reason: z.string() },
    },
    async (args) => {
      const result = await ctx.backend.messageRespond({
        message_id: args.message_id,
        response: args.reason,
        dismiss: true,
      })
      if (result.ok) resolveLocally(args.message_id)
      return asText(result)
    },
  )
}

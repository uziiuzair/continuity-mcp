import { pgSchema } from "@continuity/shared"
import type { Db } from "./db.js"

// Best-effort audit write shared by every route. Never throws into the request
// path — an audit failure must not fail the coordinating action it records.
export async function writeAudit(
  db: Db,
  eventType: string,
  userId: string | null,
  sessionId: string | null,
  payload: unknown,
): Promise<void> {
  try {
    await db.insert(pgSchema.auditEvents).values({
      eventType,
      userId,
      agentSessionId: sessionId,
      payload: payload != null ? JSON.stringify(payload) : null,
    })
  } catch {
    // swallow — audit is non-critical
  }
}

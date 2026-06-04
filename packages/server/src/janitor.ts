import {
  FILE_ACTIVITY_PRUNE_MS,
  SESSION_GONE_MS,
  SESSION_IDLE_MS,
  pgSchema,
} from "@continuity/shared"
import { and, eq, inArray, lt } from "drizzle-orm"
import { makeDb } from "./db.js"
import type { Bindings } from "./types.js"

const { agentSessions, fileActivity, taskClaims } = pgSchema

// Runs on the 1-minute cron. Flips stale sessions idle → gone, prunes old file
// activity, and auto-releases expired task claims. The local flavor does this
// lazily on read instead; both use the same thresholds from @continuity/shared.
export async function runJanitor(env: Bindings): Promise<void> {
  const db = makeDb(env.DATABASE_URL)
  const now = Date.now()

  await db
    .update(agentSessions)
    .set({ status: "gone", endedAt: new Date(now) })
    .where(
      and(
        inArray(agentSessions.status, ["active", "idle"]),
        lt(agentSessions.lastSeenAt, new Date(now - SESSION_GONE_MS)),
      ),
    )

  await db
    .update(agentSessions)
    .set({ status: "idle" })
    .where(
      and(
        eq(agentSessions.status, "active"),
        lt(agentSessions.lastSeenAt, new Date(now - SESSION_IDLE_MS)),
      ),
    )

  await db.delete(fileActivity).where(lt(fileActivity.touchedAt, new Date(now - FILE_ACTIVITY_PRUNE_MS)))

  await db
    .update(taskClaims)
    .set({ status: "released" })
    .where(
      and(
        inArray(taskClaims.status, ["claimed", "in_progress", "pr_open"]),
        lt(taskClaims.expiresAt, new Date(now)),
      ),
    )
}

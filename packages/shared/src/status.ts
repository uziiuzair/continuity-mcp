// Lazy session-status derivation. The local flavor has no cron, so presence
// reads compute live status from `last_seen_at` instead of trusting a stored
// column. The Worker uses the same thresholds in its janitor + read paths, so
// both flavors agree on when a session is idle vs gone.

import { SESSION_GONE_MS, SESSION_IDLE_MS } from "./constants.js"
import { type TimestampLike, msSince } from "./time.js"
import type { SessionStatus } from "./types.js"

/**
 * Derive the effective status from the last heartbeat.
 * < 5m → active, < 30m → idle, otherwise gone.
 * A stored "gone" (explicit checkout) always wins.
 */
export function derivedStatus(
  lastSeenAt: TimestampLike,
  stored: SessionStatus | null = null,
  now: number = Date.now(),
): SessionStatus {
  if (stored === "gone") return "gone"
  const age = msSince(lastSeenAt, now)
  if (age >= SESSION_GONE_MS) return "gone"
  if (age >= SESSION_IDLE_MS) return "idle"
  return "active"
}

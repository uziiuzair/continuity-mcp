// Coordination thresholds and enum vocabularies shared by both flavors.
// Centralized here so the local backend's lazy expiry and the Worker's janitor
// cron derive identical behavior from one source of truth.

/** A session with no heartbeat for this long is reported as "idle". */
export const SESSION_IDLE_MS = 5 * 60_000 // 5 minutes
/** A session with no heartbeat for this long is reported/marked as "gone". */
export const SESSION_GONE_MS = 30 * 60_000 // 30 minutes
/** A task claim with no activity for this long auto-releases. */
export const CLAIM_TTL_MS = 6 * 60 * 60_000 // 6 hours
/** File-activity rows older than this are pruned. */
export const FILE_ACTIVITY_PRUNE_MS = 24 * 60 * 60_000 // 24 hours

/** Default lookback for `agent_list_active` (seconds). */
export const DEFAULT_LIST_ACTIVE_WINDOW_S = 300
/** Default lookback for `agent_file_activity_recent` (seconds). */
export const DEFAULT_RECENT_FILE_WINDOW_S = 1800
/** Default lookback for `decision_recent` (seconds): 7 days. */
export const DEFAULT_DECISION_RECENT_WINDOW_S = 7 * 24 * 60 * 60

// ---- Enum vocabularies (kept as readonly tuples for runtime validation) ----

export const SESSION_STATUSES = ["active", "idle", "gone"] as const
export const DECISION_TYPES = ["architecture", "tooling", "process", "scope", "other"] as const
export const DECISION_STATUSES = ["active", "pending", "superseded", "rejected"] as const
export const CLAIM_STATUSES = ["claimed", "in_progress", "pr_open", "released", "completed"] as const
export const LIVE_CLAIM_STATUSES = ["claimed", "in_progress", "pr_open"] as const
export const HANDOFF_STATUSES = ["pending", "accepted", "completed", "expired"] as const
export const FILE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const

import type { ContinuityBackend } from "@continuity/shared"
import type { TeamBackend } from "../backends/remote.js"

// Runtime context the tools close over. `getSessionId` is read lazily because
// the shim may re-adopt a session id (idempotent checkin reuse) after startup.
// `backend` is the only storage seam — tools never touch HTTP or SQL directly,
// so the same tool code serves both the local and remote flavors.
export type ToolContext = {
  backend: ContinuityBackend
  getSessionId: () => string | null
  repoFullName: string | null
  mode: "local" | "remote"
  // Handlers use this to read/write the session state file's gate caches
  // (pending_inbound, collision_sent) synchronously, in-process.
  cwdHash: string
}

// Context for the team-flavor-only tools (github_*, plan_*, escalate). These
// proxy to the Cloudflare Worker via the TeamBackend surface, which only
// RemoteBackend implements — so they're registered only in remote mode.
export type TeamToolContext = {
  team: TeamBackend
  getSessionId: () => string | null
  repoFullName: string | null
}

export const asText = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})

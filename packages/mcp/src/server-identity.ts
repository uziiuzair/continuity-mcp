import { basename } from "node:path"
import type { ContinuityBackend } from "@continuity/shared"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { type RepoContext, resolveRepoContext } from "./gate.js"
import { resolveClaudeSessionId } from "./identity.js"
import { persistSessionId, readState } from "./state.js"

// The long-lived server's identity, which can change mid-process: `/clear`
// starts a new Claude session (new session_id) without restarting the MCP
// server. Everything that keys on the identity reads it from here at use time.
export type ServerIdentity = {
  claudeSessionId: string | null
  repo: RepoContext
  agentLabel: string
  sessionId: string | null
}

export function deriveAgentLabel(repoFullName: string | null, cwdHash: string): string {
  const fromEnv = process.env.CONTINUITY_AGENT_ID
  if (fromEnv?.trim()) return fromEnv.trim()
  const repo = repoFullName ? basename(repoFullName) : "repo"
  return `${repo}-${cwdHash.slice(0, 6)}`
}

// Returns a sync that re-resolves the Claude session id and, if it changed,
// switches the identity: new cwdHash (so a new state file), new label, and a
// fresh checkin. Unchanged id costs one small rendezvous read, no network.
// Concurrent calls share one in-flight sync. Never throws past a failed
// checkin: the identity still switches and adopts whatever session id the
// SessionStart snapshot persisted for the new hash.
export function createIdentitySync(
  ident: ServerIdentity,
  deps: {
    backend: ContinuityBackend
    dir: string
    allowlist: string | undefined
    resolveId?: () => Promise<string | null>
  },
): () => Promise<void> {
  const resolveId = deps.resolveId ?? (() => resolveClaudeSessionId({ preferRendezvous: true, retries: 0 }))
  let inflight: Promise<void> | null = null

  async function run(): Promise<void> {
    const id = await resolveId()
    if (!id || id === ident.claudeSessionId) return
    const repo = resolveRepoContext(deps.dir, deps.allowlist, { claudeSessionId: id })
    if (!repo) return
    ident.claudeSessionId = id
    ident.repo = repo
    ident.agentLabel = deriveAgentLabel(repo.repoFullName, repo.cwdHash)
    ident.sessionId = readState(repo.cwdHash)?.session_id ?? null
    try {
      const res = await deps.backend.checkin({ agent_label: ident.agentLabel, cwd_hash: repo.cwdHash })
      ident.sessionId = res.session_id
      persistSessionId(repo.cwdHash, res.session_id, ident.agentLabel)
    } catch {
      // fail open: the heartbeat tick checks in once the backend is back
    }
  }

  return () => {
    inflight ??= run().finally(() => {
      inflight = null
    })
    return inflight
  }
}

// Wrap server.registerTool so every tool call first runs `sync` (fail open:
// a failed sync never blocks the tool). Call before registering any tools.
export function syncBeforeEachTool(server: McpServer, sync: () => Promise<void>): void {
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: Callback) => unknown
  ;(server as unknown as { registerTool: unknown }).registerTool = (name: string, config: unknown, cb: Callback) =>
    register(name, config, async (...args: unknown[]) => {
      await sync().catch(() => {})
      return cb(...args)
    })
}

type Callback = (...args: unknown[]) => unknown

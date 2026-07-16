import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import type { ContinuityBackend, FileTool } from "@continuity/shared"
import { FILE_TOOLS } from "@continuity/shared"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { openLocalDb } from "./backends/db.js"
import { LocalBackend } from "./backends/local.js"
import { RemoteBackend } from "./backends/remote.js"
import { type DeltaMemory, type SnapshotData, computeDeltas } from "./deltas.js"
import { type SettingsLike, duplicateInstallWarning, listContinuityInstalls } from "./doctor.js"
import { type RepoContext, resolveRepoContext } from "./gate.js"
import { buildOthersCache } from "./guard.js"
import { renderSnapshot } from "./snapshot.js"
import { type SessionState, clearState, readState, stateFilePath, writeState } from "./state.js"
import { registerAgentTools } from "./tools/agent.js"
import { registerDecisionTools } from "./tools/decisions.js"
import { registerGithubTools } from "./tools/github.js"
import { registerHandoffTools } from "./tools/handoffs.js"
import { registerPlanTools } from "./tools/plan.js"
import { registerTaskTools } from "./tools/tasks.js"
import type { TeamToolContext, ToolContext } from "./tools/util.js"

const HEARTBEAT_MS = 45_000
// Flush pending file edits that have been sitting unreported for this long, so a
// trailing edit (after the hook's burst threshold stopped firing) isn't lost.
const PENDING_STALE_MS = 20_000

type Mode = "local" | "remote"
type Runtime = { repo: RepoContext; backend: ContinuityBackend; mode: Mode; agentLabel: string }

function deriveAgentLabel(repoFullName: string | null, cwdHash: string): string {
  const fromEnv = process.env.CONTINUITY_AGENT_ID
  if (fromEnv?.trim()) return fromEnv.trim()
  const repo = repoFullName ? basename(repoFullName) : "repo"
  return `${repo}-${cwdHash.slice(0, 6)}`
}

function defaultDbPath(): string {
  return process.env.CONTINUITY_DB_PATH?.trim() || join(homedir(), ".continuity", "continuity.db")
}

// Resolve the repo gate and pick a backend flavor. Returns null when inert
// (not in an activated git repo).
function resolveRuntime(): Runtime | null {
  const apiUrl = process.env.CONTINUITY_API_URL?.trim()
  const apiKey = process.env.CONTINUITY_API_KEY?.trim()
  const allowlist = process.env.CONTINUITY_REPO_ALLOWLIST

  const repo = resolveRepoContext(process.cwd(), allowlist)
  if (!repo) return null

  const mode: Mode = apiUrl && apiKey ? "remote" : "local"
  const backend: ContinuityBackend =
    mode === "remote"
      ? new RemoteBackend(apiUrl as string, apiKey as string)
      : new LocalBackend(openLocalDb(defaultDbPath()))
  return { repo, backend, mode, agentLabel: deriveAgentLabel(repo.repoFullName, repo.cwdHash) }
}

function persistSessionId(cwdHash: string, sessionId: string, agentLabel: string): void {
  const prev = readState(cwdHash)
  // Spread prev first: the state file also carries the delta/collision caches,
  // which a session-id refresh must not wipe.
  writeState(cwdHash, {
    ...prev,
    session_id: sessionId,
    agent_label: agentLabel,
    project_scope: prev?.project_scope ?? null,
    pending_files: prev?.pending_files ?? [],
    last_file_report_at: prev?.last_file_report_at ?? null,
  })
}

// The four coordination queries the snapshot and the prompt-sync deltas share.
async function fetchCoordinationData(rt: Runtime, sessionIdOrNull: string | null): Promise<SnapshotData> {
  const { backend, repo } = rt
  const sessionId = sessionIdOrNull ?? undefined
  const [active, activity, decisions, handoffs] = await Promise.all([
    backend.listActive({ max_age_seconds: 300, exclude_session: sessionId }).then((r) => r.sessions).catch(() => []),
    backend.recentFileActivity({ since_seconds: 1800, exclude_session: sessionId }).then((r) => r.activity).catch(() => []),
    backend.decisionRecent({ limit: 5 }).then((r) => r.decisions).catch(() => []),
    backend.handoffPending({ agent_session_id: sessionId }).then((r) => r.handoffs).catch(() => []),
  ])
  return {
    active,
    activity,
    decisions,
    handoffs,
    messages: { inbound: [], resolved: [] }, // Task 8 wires the real messagePending fetch
    repoFullName: repo.repoFullName,
  }
}

// Persist the delta baseline + the collision guard's others-activity cache.
function persistCoordinationCaches(cwdHash: string, data: SnapshotData, memory: DeltaMemory): void {
  const latest: SessionState = readState(cwdHash) ?? {
    session_id: null,
    agent_label: null,
    project_scope: null,
    pending_files: [],
    last_file_report_at: null,
  }
  writeState(cwdHash, {
    ...latest,
    delta_memory: memory,
    delta_synced_at: Date.now(),
    others_activity: buildOthersCache(data.activity, data.repoFullName),
  })
}

// `--snapshot`: check in and print the coordination snapshot, then exit. Run by
// the plugin's SessionStart hook (separate, short-lived process from the server).
async function runSnapshot(rt: Runtime): Promise<void> {
  const { repo, backend, agentLabel } = rt
  let sessionId = readState(repo.cwdHash)?.session_id ?? null
  try {
    const res = await backend.checkin({ agent_label: agentLabel, cwd_hash: repo.cwdHash })
    sessionId = res.session_id
    persistSessionId(repo.cwdHash, sessionId, agentLabel)
  } catch {
    return // backend unreachable — stay silent, the server will retry
  }

  const data = await fetchCoordinationData(rt, sessionId)
  // Seed the prompt-sync baseline: everything in this snapshot has been shown,
  // so the first delta only announces what arrives after it.
  const seeded = computeDeltas(null, data, Date.now())
  persistCoordinationCaches(repo.cwdHash, data, seeded.memory)
  process.stdout.write(renderSnapshot(data))
}

// How often --prompt-sync may hit the backend for deltas. Prompts inside the
// window still heartbeat the focus but skip the fetch, so rapid-fire prompting
// never queues coordination queries (this is the per-prompt latency budget).
const DELTA_THROTTLE_MS = 20_000

// `--prompt-sync <focus>`: heartbeat the focus, then print what changed since
// the last sync (new sessions, others' file activity, decisions, handoffs).
// Run by UserPromptSubmit; any output is injected as additionalContext.
async function runPromptSync(rt: Runtime, focus: string): Promise<void> {
  const { repo, backend, agentLabel } = rt
  let sessionId = readState(repo.cwdHash)?.session_id ?? null
  try {
    if (!sessionId) {
      const res = await backend.checkin({ agent_label: agentLabel, cwd_hash: repo.cwdHash })
      sessionId = res.session_id
      persistSessionId(repo.cwdHash, sessionId, agentLabel)
    }
    await backend.heartbeat({
      session_id: sessionId,
      ...(focus.trim() ? { current_focus: focus.slice(0, 280) } : {}),
    })
  } catch {
    return // backend unreachable — no deltas either; fail open
  }

  const now = Date.now()
  const state = readState(repo.cwdHash)
  if (state?.delta_memory && now - (state.delta_synced_at ?? 0) < DELTA_THROTTLE_MS) return

  const data = await fetchCoordinationData(rt, sessionId)
  const { text, memory } = computeDeltas(state?.delta_memory ?? null, data, now)
  persistCoordinationCaches(repo.cwdHash, data, memory)
  if (text) process.stdout.write(text)
}

// `--doctor`: print a diagnostic report. Works even when inert — that's when
// you need it most.
async function runDoctor(rt: Runtime | null): Promise<void> {
  const out: string[] = [`continuity-mcp v${pkg.version}`]
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number)
  const nodeOk = major > 22 || (major === 22 && minor >= 5)
  out.push(`node ${process.versions.node} — ${nodeOk ? "OK" : "TOO OLD (need >= 22.5 for node:sqlite)"}`)

  if (!rt) {
    const allowlist = process.env.CONTINUITY_REPO_ALLOWLIST?.trim()
    out.push(
      "repo gate: INERT — not a git repo" +
        (allowlist ? `, or remote not in allowlist (${allowlist})` : "") +
        ` (cwd: ${process.cwd()})`,
    )
  } else {
    out.push(`repo gate: ACTIVE — ${rt.repo.repoFullName ?? "no remote"} (${rt.repo.toplevel})`)
    out.push(`mode: ${rt.mode}${rt.mode === "local" ? ` — db: ${defaultDbPath()}` : ` — api: ${process.env.CONTINUITY_API_URL}`}`)
    try {
      await rt.backend.listActive({ max_age_seconds: 60 })
      out.push("backend: reachable")
    } catch (err) {
      out.push(`backend: UNREACHABLE — ${err instanceof Error ? err.message : String(err)}`)
    }
    const state = readState(rt.repo.cwdHash)
    out.push(`session state: ${state?.session_id ? `session ${state.session_id}` : "none yet"} (${stateFilePath(rt.repo.cwdHash)})`)
  }

  try {
    const readJson = (p: string): SettingsLike => {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as SettingsLike
      } catch {
        return null
      }
    }
    const chain: SettingsLike[] = [readJson(join(homedir(), ".claude", "settings.json"))]
    if (rt) {
      chain.push(readJson(join(rt.repo.toplevel, ".claude", "settings.json")))
      chain.push(readJson(join(rt.repo.toplevel, ".claude", "settings.local.json")))
    }
    const installed = readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8")
    const installs = listContinuityInstalls(installed)
    const dup = duplicateInstallWarning(installed, chain)
    if (dup) out.push(dup)
    else if (installs.length === 0) out.push("plugin installs: none registered (running outside a plugin?)")
    else out.push(`plugin installs: OK — ${installs.map((i) => i.key).join(", ")} (1 enabled)`)
  } catch {
    out.push("plugin installs: could not read installed_plugins.json (skipped)")
  }

  process.stdout.write(`${out.join("\n")}\n`)
}

// `--checkin`: establish presence for this cwd, then exit. Run by hooks that
// signal a new working context (CwdChanged, WorktreeCreate).
async function runCheckin(rt: Runtime): Promise<void> {
  const { repo, backend, agentLabel } = rt
  try {
    const res = await backend.checkin({ agent_label: agentLabel, cwd_hash: repo.cwdHash })
    persistSessionId(repo.cwdHash, res.session_id, agentLabel)
  } catch {
    // fail-open
  }
}

// `--checkout`: mark this cwd's session gone and clear the rendezvous file. Run
// by SessionEnd and WorktreeRemove.
async function runCheckout(rt: Runtime): Promise<void> {
  const { repo, backend } = rt
  const sessionId = readState(repo.cwdHash)?.session_id ?? null
  if (sessionId) {
    try {
      await backend.checkout({ session_id: sessionId, reason: "session_end" })
    } catch {
      // fail-open — the janitor/lazy expiry will reap it
    }
  }
  clearState(repo.cwdHash)
}

// `--focus <text...>`: update this session's current focus. Run by
// UserPromptSubmit so teammates' agents see what you're working on.
async function runFocus(rt: Runtime, focus: string): Promise<void> {
  const { repo, backend, agentLabel } = rt
  if (!focus.trim()) return
  let sessionId = readState(repo.cwdHash)?.session_id ?? null
  try {
    if (!sessionId) {
      const res = await backend.checkin({ agent_label: agentLabel, cwd_hash: repo.cwdHash })
      sessionId = res.session_id
      persistSessionId(repo.cwdHash, sessionId, agentLabel)
    }
    await backend.heartbeat({ session_id: sessionId, current_focus: focus.slice(0, 280) })
  } catch {
    // fail-open
  }
}

// `--audit <event_type>`: record a coordination audit event. Run by
// TaskCreated / TaskCompleted.
async function runAudit(rt: Runtime, eventType: string): Promise<void> {
  const { repo, backend } = rt
  if (!eventType.trim()) return
  const sessionId = readState(repo.cwdHash)?.session_id ?? undefined
  try {
    await backend.auditEvent({ event_type: eventType, session_id: sessionId })
  } catch {
    // fail-open
  }
}

// Default mode: run the long-lived MCP server.
async function runServer(rt: Runtime): Promise<void> {
  const { repo, backend, mode, agentLabel } = rt
  const { cwdHash, repoFullName } = repo
  const server = new McpServer({ name: "continuity", version: pkg.version })

  // Adopt any session id the SessionStart hook wrote, then check in (idempotent
  // on cwd) so the hook and the shim converge on one session row.
  let sessionId: string | null = readState(cwdHash)?.session_id ?? null
  try {
    const res = await backend.checkin({ agent_label: agentLabel, cwd_hash: cwdHash })
    sessionId = res.session_id
    persistSessionId(cwdHash, sessionId, agentLabel)
  } catch {
    // Fail-open: serve tools even if the backend is unreachable at startup.
  }

  const toolContext: ToolContext = { backend, getSessionId: () => sessionId, repoFullName, mode }
  registerAgentTools(server, toolContext)
  registerDecisionTools(server, toolContext)
  registerTaskTools(server, toolContext)
  registerHandoffTools(server, toolContext)

  // Team-flavor extras (github_*, plan_*, escalate). These proxy to the
  // Cloudflare Worker via the TeamBackend surface that only RemoteBackend
  // implements, so they attach only in remote mode. Local mode never sees them.
  if (mode === "remote") {
    const teamContext: TeamToolContext = {
      team: backend as RemoteBackend,
      getSessionId: () => sessionId,
      repoFullName,
    }
    registerGithubTools(server, teamContext)
    registerPlanTools(server, teamContext)
  }

  const heartbeat = setInterval(() => void tick(), HEARTBEAT_MS)
  heartbeat.unref?.()

  async function tick(): Promise<void> {
    const state = readState(cwdHash)
    if (state?.session_id) sessionId = state.session_id
    try {
      if (!sessionId) {
        const res = await backend.checkin({ agent_label: agentLabel, cwd_hash: cwdHash })
        sessionId = res.session_id
        persistSessionId(cwdHash, sessionId, agentLabel)
      } else {
        await backend.heartbeat({ session_id: sessionId })
      }
    } catch {
      return // backend down; retry next tick
    }
    await flushPending(state)
  }

  async function flushPending(state: SessionState | null): Promise<void> {
    if (!state || !sessionId) return
    const pending = state.pending_files ?? []
    if (pending.length === 0) return
    if (Date.now() - (state.last_file_report_at ?? 0) < PENDING_STALE_MS) return
    const files = pending
      .filter((f) => FILE_TOOLS.includes(f.tool as FileTool))
      .map((f) => ({ path: f.path, tool: f.tool as FileTool }))
    if (files.length === 0) return
    try {
      await backend.fileActivity({ session_id: sessionId, repo_full_name: repoFullName, files })
      // The PostToolUse hook may have appended paths while the flush was in
      // flight. Re-read and subtract only what we actually flushed, so a
      // concurrent append is never silently dropped.
      const latest = readState(cwdHash) ?? state
      const flushed = new Set(files.map((f) => f.path))
      writeState(cwdHash, {
        ...latest,
        pending_files: (latest.pending_files ?? []).filter((f) => !flushed.has(f.path)),
        last_file_report_at: Date.now(),
      })
    } catch {
      // leave pending in place; next tick retries
    }
  }

  // Registering a signal handler removes Node's default terminate-on-signal
  // behavior, so we must exit ourselves once the best-effort checkout settles
  // (capped at 2s so a hung backend can't keep the process alive).
  const shutdown = (): void => {
    clearInterval(heartbeat)
    const exit = (): void => process.exit(0)
    setTimeout(exit, 2_000)
    if (sessionId) {
      void backend.checkout({ session_id: sessionId, reason: "shim_shutdown" }).catch(() => {}).finally(exit)
    } else {
      exit()
    }
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  await server.connect(new StdioServerTransport())
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const has = (f: string): boolean => args.includes(f)
  const valueAfter = (f: string): string => {
    const i = args.indexOf(f)
    return i >= 0 ? (args[i + 1] ?? "") : ""
  }
  // One-shot CLI subcommands run by the plugin hooks (each a short-lived process
  // separate from the long-lived server). No flag → run the server.
  const isSubcommand =
    has("--snapshot") ||
    has("--checkin") ||
    has("--checkout") ||
    has("--focus") ||
    has("--prompt-sync") ||
    has("--audit") ||
    has("--doctor")

  const rt = resolveRuntime()
  // Doctor runs even when inert — diagnosing "why is Continuity inactive here"
  // is its main job.
  if (has("--doctor")) return runDoctor(rt)
  if (!rt) {
    // Inert: not an activated git repo. The long-lived server still completes the
    // MCP handshake so Claude Code is happy; one-shot subcommands just exit.
    // Declare the tools capability with an empty list (instead of leaving
    // tools/list unhandled → -32601) so strict MCP clients see "no tools", not
    // an error.
    if (!isSubcommand) {
      const server = new McpServer({ name: "continuity", version: pkg.version })
      server.server.registerCapabilities({ tools: {} })
      server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
      await server.connect(new StdioServerTransport())
    }
    return
  }

  if (has("--snapshot")) return runSnapshot(rt)
  if (has("--checkin")) return runCheckin(rt)
  if (has("--checkout")) return runCheckout(rt)
  if (has("--focus")) return runFocus(rt, valueAfter("--focus"))
  if (has("--prompt-sync")) return runPromptSync(rt, valueAfter("--prompt-sync"))
  if (has("--audit")) return runAudit(rt, valueAfter("--audit"))
  return runServer(rt)
}

main().catch((err) => {
  console.error("[continuity-mcp] fatal", err)
  process.exit(1)
})

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { LOOP_CRON_PROMPT } from "@continuity/shared"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveRepoContext } from "./gate.js"
import { type LoopState, type SessionState, readState, writeState } from "./state.js"

// Integration: runs the real plugin/scripts/stop.mjs hook as a subprocess with
// crafted stdin, against a scratch git repo and a temp CONTINUITY_STATE_DIR.
const STOP_HOOK = fileURLToPath(new URL("../../../plugin/scripts/stop.mjs", import.meta.url))
const CLAUDE_ID = "claude-stop-hook-test"

let repoDir: string
let stateDir: string
let savedStateDir: string | undefined
let cwdHash: string

const loop = (cron_job_id: string | null): LoopState => ({
  started_at: 1,
  task: "t",
  tier: 1,
  quiet_streak: 0,
  own_work_done: false,
  cron_job_id,
  last_tick_at: 1,
  seen: { messages: [], responses: [], handoffs: [], decisions: [], sessions: [] },
})

const baseState = (extra: Partial<SessionState> = {}): SessionState => ({
  session_id: "me",
  agent_label: "my-label",
  project_scope: null,
  pending_files: [{ path: "a.ts", tool: "Edit" }],
  last_file_report_at: 42,
  message_warned: ["w1"],
  ...extra,
})

function runStop(input: Record<string, unknown>): string {
  const env: NodeJS.ProcessEnv = { ...process.env, CONTINUITY_STATE_DIR: stateDir }
  for (const k of [
    "CONTINUITY_SESSION_ID",
    "CONTINUITY_REPO_ALLOWLIST",
    "CLAUDE_PLUGIN_OPTION_REPOALLOWLIST",
    "CLAUDE_PLUGIN_OPTION_REPO_ALLOWLIST",
    "CLAUDE_CODE_SESSION_ID",
  ])
    delete env[k]
  return execFileSync(process.execPath, [STOP_HOOK], {
    input: JSON.stringify({ cwd: repoDir, session_id: CLAUDE_ID, stop_hook_active: false, ...input }),
    env,
    encoding: "utf8",
    timeout: 10_000,
  })
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "continuity-stop-repo-"))
  execFileSync("git", ["init", "-q"], { cwd: repoDir })
  stateDir = mkdtempSync(join(tmpdir(), "continuity-stop-state-"))
  savedStateDir = process.env.CONTINUITY_STATE_DIR
  process.env.CONTINUITY_STATE_DIR = stateDir
  const saltSaved = process.env.CONTINUITY_SESSION_ID
  delete process.env.CONTINUITY_SESSION_ID
  const ctx = resolveRepoContext(repoDir, undefined, { claudeSessionId: CLAUDE_ID })
  if (saltSaved !== undefined) process.env.CONTINUITY_SESSION_ID = saltSaved
  if (!ctx) throw new Error("scratch repo not activated")
  cwdHash = ctx.cwdHash
})

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.CONTINUITY_STATE_DIR
  else process.env.CONTINUITY_STATE_DIR = savedStateDir
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

describe("stop.mjs hook (integration)", () => {
  it("loop ended but a marked cron lingers → block JSON asking for CronDelete", () => {
    writeState(cwdHash, baseState({ loop: null }))
    const out = runStop({ session_crons: [{ id: "job-1", prompt: LOOP_CRON_PROMPT }, { id: "u", prompt: "other" }] })
    expect(JSON.parse(out)).toEqual({ decision: "block", reason: "Continuity Loop has ended; CronDelete job-1." })
  })

  it("loop with a cron id but no marked cron → loop cleared, other state kept, no block", () => {
    writeState(cwdHash, baseState({ loop: loop("job-1") }))
    const out = runStop({ session_crons: [{ id: "u", prompt: "other" }] })
    expect(out).toBe("")
    expect(readState(cwdHash)).toEqual(baseState({ loop: null }))
  })
})

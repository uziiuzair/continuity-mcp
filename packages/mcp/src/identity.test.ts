import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SESSION_ID_ENV, resolveClaudeSessionId } from "./identity.js"

// The rendezvous writer is the SessionStart hook's plain-ESM module (no types);
// a computed specifier keeps tsc out of resolving it.
const writerUrl = new URL("../../../plugin/scripts/lib/identity.mjs", import.meta.url).href
const { writeRendezvous } = (await import(writerUrl)) as {
  writeRendezvous: (claudePid: number, sessionId: string) => void
}

let stateDir: string
let savedEnv: { state?: string; session?: string }

function writeByPid(pid: number, body: unknown): void {
  const dir = join(stateDir, "sessions", "by-pid")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify(body))
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "continuity-identity-"))
  savedEnv = { state: process.env.CONTINUITY_STATE_DIR, session: process.env[SESSION_ID_ENV] }
  process.env.CONTINUITY_STATE_DIR = stateDir
  // The suite may itself run inside a Claude Code session that exports the var.
  delete process.env[SESSION_ID_ENV]
})

afterEach(() => {
  for (const [key, value] of [
    ["CONTINUITY_STATE_DIR", savedEnv.state],
    [SESSION_ID_ENV, savedEnv.session],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(stateDir, { recursive: true, force: true })
})

describe("resolveClaudeSessionId", () => {
  it("uses env var when present", async () => {
    process.env[SESSION_ID_ENV] = "env-session-id"
    expect(await resolveClaudeSessionId({ retries: 0 })).toBe("env-session-id")
  })

  it("reads rendezvous for an ancestor pid", async () => {
    writeByPid(process.ppid, { session_id: "rendezvous-id", written_at: Date.now() })
    expect(await resolveClaudeSessionId({ retries: 0 })).toBe("rendezvous-id")
  })

  it("retries until the rendezvous appears", async () => {
    setTimeout(() => writeByPid(process.ppid, { session_id: "late-id", written_at: Date.now() }), 150)
    expect(await resolveClaudeSessionId({ retries: 5, delayMs: 100 })).toBe("late-id")
  })

  it("ignores a rendezvous older than the process", async () => {
    // Epoch 0 predates every ancestor's start (ps -o lstart=): a stale file
    // left by a dead process whose pid was reused.
    writeByPid(process.ppid, { session_id: "stale-id", written_at: 0 })
    expect(await resolveClaudeSessionId({ retries: 0 })).toBeNull()
  })

  it("returns null with no source", async () => {
    expect(await resolveClaudeSessionId({ retries: 1, delayMs: 10 })).toBeNull()
  })

  it("reads what the SessionStart hook's writeRendezvous wrote", async () => {
    writeRendezvous(process.ppid, "hook-written-id")
    expect(await resolveClaudeSessionId({ retries: 0 })).toBe("hook-written-id")
  })
})

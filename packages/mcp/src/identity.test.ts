import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { HOOK_SESSION_ID_ENV, SESSION_ID_ENV, resolveClaudeSessionId, setAncestorChainForTest } from "./identity.js"

// The rendezvous writer is the SessionStart hook's plain-ESM module (no types);
// a computed specifier keeps tsc out of resolving it.
const writerUrl = new URL("../../../plugin/scripts/lib/identity.mjs", import.meta.url).href
const { writeRendezvous } = (await import(writerUrl)) as {
  writeRendezvous: (claudePid: number, sessionId: string) => void
}

let stateDir: string
let savedEnv: { state?: string; session?: string; hook?: string }

function writeByPid(pid: number, body: unknown): void {
  const dir = join(stateDir, "sessions", "by-pid")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify(body))
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "continuity-identity-"))
  savedEnv = {
    state: process.env.CONTINUITY_STATE_DIR,
    session: process.env[SESSION_ID_ENV],
    hook: process.env[HOOK_SESSION_ID_ENV],
  }
  process.env.CONTINUITY_STATE_DIR = stateDir
  // The suite may itself run inside a Claude Code session that exports the var.
  delete process.env[SESSION_ID_ENV]
  delete process.env[HOOK_SESSION_ID_ENV]
})

afterEach(() => {
  for (const [key, value] of [
    ["CONTINUITY_STATE_DIR", savedEnv.state],
    [SESSION_ID_ENV, savedEnv.session],
    [HOOK_SESSION_ID_ENV, savedEnv.hook],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setAncestorChainForTest(null)
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
    setAncestorChainForTest([{ pid: process.ppid, startedAt: 0, isClaude: true }])
    setTimeout(() => writeByPid(process.ppid, { session_id: "late-id", written_at: Date.now() }), 150)
    expect(await resolveClaudeSessionId({ retries: 5, delayMs: 100 })).toBe("late-id")
  })

  it("no claude ancestor → no polling (non-Claude hosts start fast)", async () => {
    setAncestorChainForTest([{ pid: process.ppid, startedAt: 0, isClaude: false }])
    const late = new Promise<void>((resolve) =>
      setTimeout(() => {
        writeByPid(process.ppid, { session_id: "late-id", written_at: Date.now() })
        resolve()
      }, 50),
    )
    const t0 = Date.now()
    expect(await resolveClaudeSessionId({ retries: 5, delayMs: 100 })).toBeNull()
    expect(Date.now() - t0).toBeLessThan(50)
    // Let the late write land in this test's state dir, not the next test's.
    await late
  })

  it("no claude ancestor still reads a rendezvous already present", async () => {
    setAncestorChainForTest([{ pid: process.ppid, startedAt: 0, isClaude: false }])
    writeByPid(process.ppid, { session_id: "present-id", written_at: Date.now() })
    expect(await resolveClaudeSessionId({ retries: 5, delayMs: 100 })).toBe("present-id")
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

  it("the hook-provided id wins over everything", async () => {
    process.env[HOOK_SESSION_ID_ENV] = "hook-input-id"
    process.env[SESSION_ID_ENV] = "env-session-id"
    writeByPid(process.ppid, { session_id: "rendezvous-id", written_at: Date.now() })
    expect(await resolveClaudeSessionId({ retries: 0 })).toBe("hook-input-id")
    expect(await resolveClaudeSessionId({ retries: 0, preferRendezvous: true })).toBe("hook-input-id")
  })

  // After /clear, SessionStart rewrites the rendezvous with the new id while
  // the long-lived server's env still carries the old one.
  it("preferRendezvous: rendezvous id newer than env wins", async () => {
    process.env[SESSION_ID_ENV] = "env-before-clear"
    writeByPid(process.ppid, { session_id: "after-clear", written_at: Date.now() })
    expect(await resolveClaudeSessionId({ retries: 0, preferRendezvous: true })).toBe("after-clear")
    // Default mode keeps the env-first order.
    expect(await resolveClaudeSessionId({ retries: 0 })).toBe("env-before-clear")
  })

  it("preferRendezvous: falls back to env without a fresh rendezvous", async () => {
    process.env[SESSION_ID_ENV] = "env-session-id"
    expect(await resolveClaudeSessionId({ retries: 0, preferRendezvous: true })).toBe("env-session-id")
    writeByPid(process.ppid, { session_id: "stale-id", written_at: 0 })
    expect(await resolveClaudeSessionId({ retries: 0, preferRendezvous: true })).toBe("env-session-id")
  })
})

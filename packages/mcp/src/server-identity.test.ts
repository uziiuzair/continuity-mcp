import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openLocalDb } from "./backends/db.js"
import { LocalBackend } from "./backends/local.js"
import { resolveRepoContext } from "./gate.js"
import { HOOK_SESSION_ID_ENV, SESSION_ID_ENV } from "./identity.js"
import { type ServerIdentity, createIdentitySync, deriveAgentLabel, syncBeforeEachTool } from "./server-identity.js"
import { readState } from "./state.js"

const hashOf = (id: string): string => createHash("sha256").update(`claude:${id}`).digest("hex").slice(0, 16)

let stateDir: string
let repoDir: string
let saved: Record<string, string | undefined>
const KEYS = ["CONTINUITY_STATE_DIR", SESSION_ID_ENV, HOOK_SESSION_ID_ENV, "CONTINUITY_SESSION_ID"]

function writeRendezvous(sessionId: string): void {
  const dir = join(stateDir, "sessions", "by-pid")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${process.ppid}.json`), JSON.stringify({ session_id: sessionId, written_at: Date.now() }))
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  stateDir = mkdtempSync(join(tmpdir(), "continuity-server-identity-"))
  repoDir = mkdtempSync(join(tmpdir(), "continuity-server-identity-repo-"))
  execFileSync("git", ["init", "-q"], { cwd: repoDir })
  process.env.CONTINUITY_STATE_DIR = stateDir
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

async function startedAs(backend: LocalBackend, claudeSessionId: string): Promise<ServerIdentity> {
  const repo = resolveRepoContext(repoDir, undefined, { claudeSessionId })
  if (!repo) throw new Error("scratch repo not detected")
  const agentLabel = deriveAgentLabel(repo.repoFullName, repo.cwdHash)
  const { session_id } = await backend.checkin({ agent_label: agentLabel, cwd_hash: repo.cwdHash })
  return { claudeSessionId, repo, agentLabel, sessionId: session_id }
}

describe("createIdentitySync", () => {
  it("switches identity when the Claude session id changes (/clear)", async () => {
    const backend = new LocalBackend(openLocalDb(":memory:"))
    process.env[SESSION_ID_ENV] = "before-clear" // the server's env never changes
    const ident = await startedAs(backend, "before-clear")
    const oldSession = ident.sessionId
    const sync = createIdentitySync(ident, { backend, dir: repoDir, allowlist: undefined })

    writeRendezvous("after-clear") // SessionStart after /clear
    await sync()

    expect(ident.claudeSessionId).toBe("after-clear")
    expect(ident.repo.cwdHash).toBe(hashOf("after-clear"))
    expect(ident.agentLabel).toBe(deriveAgentLabel(ident.repo.repoFullName, hashOf("after-clear")))
    expect(ident.sessionId).toBeTruthy()
    expect(ident.sessionId).not.toBe(oldSession)
    expect(readState(hashOf("after-clear"))?.session_id).toBe(ident.sessionId)
  })

  it("does nothing (no checkin) while the id is unchanged", async () => {
    const backend = new LocalBackend(openLocalDb(":memory:"))
    process.env[SESSION_ID_ENV] = "steady"
    const ident = await startedAs(backend, "steady")
    const before = { ...ident }
    const checkin = vi.spyOn(backend, "checkin")
    const sync = createIdentitySync(ident, { backend, dir: repoDir, allowlist: undefined })

    await sync()
    writeRendezvous("steady") // a --resume rewrites the same id
    await sync()

    expect(checkin).not.toHaveBeenCalled()
    expect(ident).toEqual(before)
  })

  it("keeps the current identity when no id resolves", async () => {
    const backend = new LocalBackend(openLocalDb(":memory:"))
    const ident = await startedAs(backend, "only-at-start")
    const before = { ...ident }
    await createIdentitySync(ident, { backend, dir: repoDir, allowlist: undefined })()
    expect(ident).toEqual(before)
  })

  it("adopts the session id the SessionStart snapshot already persisted when checkin fails", async () => {
    const backend = new LocalBackend(openLocalDb(":memory:"))
    process.env[SESSION_ID_ENV] = "before-clear"
    const ident = await startedAs(backend, "before-clear")
    const fresh = await backend.checkin({ agent_label: "x", cwd_hash: hashOf("after-clear") })
    mkdirSync(join(stateDir, "sessions"), { recursive: true })
    writeFileSync(
      join(stateDir, "sessions", `${hashOf("after-clear")}.json`),
      JSON.stringify({ session_id: fresh.session_id, agent_label: "x", project_scope: null, pending_files: [], last_file_report_at: null }),
    )
    vi.spyOn(backend, "checkin").mockRejectedValue(new Error("backend down"))
    writeRendezvous("after-clear")
    await createIdentitySync(ident, { backend, dir: repoDir, allowlist: undefined })()
    expect(ident.repo.cwdHash).toBe(hashOf("after-clear"))
    expect(ident.sessionId).toBe(fresh.session_id)
  })
})

describe("syncBeforeEachTool", () => {
  it("runs the sync before every tool callback, and the callback still runs if sync throws", async () => {
    const callbacks: Array<(...a: unknown[]) => unknown> = []
    const fake = {
      registerTool(_name: string, _config: unknown, cb: (...a: unknown[]) => unknown) {
        callbacks.push(cb)
      },
    }
    const order: string[] = []
    let fail = false
    syncBeforeEachTool(fake as unknown as McpServer, async () => {
      order.push("sync")
      if (fail) throw new Error("boom")
    })
    fake.registerTool("t", {}, async (arg: unknown) => {
      order.push(`tool:${String(arg)}`)
      return "ok"
    })
    expect(await callbacks[0]?.("a")).toBe("ok")
    fail = true
    expect(await callbacks[0]?.("b")).toBe("ok")
    expect(order).toEqual(["sync", "tool:a", "sync", "tool:b"])
  })
})

import { execFileSync } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { dataDir } from "./state.mjs"

// Writer side of the session-id rendezvous read by packages/mcp/src/identity.ts.
// SessionStart records Claude's session_id under Claude's pid; the MCP shim,
// which gets no hook input, finds it by walking its own parent chain.

const MAX_ANCESTORS = 4

function psParentAndComm(pid) {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    })
    const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(out)
    return m ? { ppid: Number(m[1]), comm: m[2] } : null
  } catch {
    return null
  }
}

// The first ancestor whose `ps -o comm=` contains "claude". Claude spawns hooks
// directly, so fall back to our parent when no ancestor carries the name.
export function findClaudePid() {
  let pid = process.ppid
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const info = psParentAndComm(pid)
    if (!info) break
    if (/claude/i.test(info.comm)) return pid
    pid = info.ppid
  }
  return process.ppid
}

export function writeRendezvous(claudePid, sessionId) {
  const path = join(dataDir(), "sessions", "by-pid", `${claudePid}.json`)
  mkdirSync(join(dataDir(), "sessions", "by-pid"), { recursive: true })
  // Atomic write (tmp + rename): the shim polls this file while we write it.
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ session_id: sessionId, written_at: Date.now() }))
  renameSync(tmp, path)
}

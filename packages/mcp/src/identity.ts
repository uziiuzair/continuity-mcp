import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { dataDir } from "./state.js"

// Which Claude Code session is this shim serving? Hooks get `session_id` in
// their stdin JSON; the MCP subprocess gets no hook input, so it resolves the
// id here.
//
// Spike findings (Claude Code 2.1.302, macOS, `claude -p` with --plugin-dir):
// - Env var: Claude Code exports CLAUDE_CODE_SESSION_ID to the MCP subprocess,
//   to every hook, and (inherited) to hook-launched shim runs. It equals the
//   hook input's `session_id` and the session id `claude -p` reports, and it
//   stays the same under `--resume <id>`. A nested `claude` overrides the
//   parent session's value, so it is the inner session's id. CLAUDE_PID is
//   NOT safe for the MCP subprocess: nested, it still carried the outer
//   Claude's pid (hooks got the right one).
// - Parent chains: the Claude process (`ps -o comm=` = "claude") is the
//   direct parent of both the MCP server (`node launch.mjs`) and each hook
//   (`node scripts/<hook>.mjs`). On Node 22.x–23.x launch.mjs re-execs the
//   bundle, so Claude is the bundle's grandparent. Hook-launched shim runs
//   (--snapshot, --prompt-sync, --checkout) are Claude's grandchildren.
// So the env var is the primary source. The pid rendezvous is the fallback:
// SessionStart writes sessions/by-pid/<claude pid>.json, and the shim finds
// it from its own ancestor chain.
export const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID"

// Ancestors examined, nearest first: enough to reach Claude through the
// launch.mjs re-exec and a hook-launched shim run.
const MAX_ANCESTORS = 4

type Ancestor = { pid: number; startedAt: number | null; isClaude: boolean }

// `ps -o ppid=,lstart=,comm=` under LC_ALL=C prints e.g.
// "26370 Wed Oct 28 18:52:17 2026 claude": lstart is always five fields.
const PS_LINE = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*?)\s*$/

function describePid(pid: number): { ppid: number; startedAt: number | null; comm: string } | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,lstart=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    })
    const [, ppid, lstart, comm] = PS_LINE.exec(out) ?? []
    if (!ppid || !lstart || comm === undefined) return null
    const startedAt = Date.parse(lstart)
    return { ppid: Number(ppid), startedAt: Number.isNaN(startedAt) ? null : startedAt, comm }
  } catch {
    return null // no POSIX ps (or the pid is gone): fail open
  }
}

// Walk process.ppid upward, stopping after the first `claude` process so a
// nested session never picks up its outer Claude's rendezvous.
function ancestorChain(): Ancestor[] {
  const chain: Ancestor[] = []
  let pid = process.ppid
  while (chain.length < MAX_ANCESTORS && pid > 1) {
    const info = describePid(pid)
    if (!info) break
    const isClaude = /claude/i.test(info.comm)
    chain.push({ pid, startedAt: info.startedAt, isClaude })
    if (isClaude) break
    pid = info.ppid
  }
  return chain
}

// A rendezvous counts only if it was written after its pid's process started
// (lstart has 1 s resolution and rounds down, so a fresh write always passes);
// that rejects a stale file left by a dead process whose pid was reused.
function readRendezvous(ancestor: Ancestor): string | null {
  if (ancestor.startedAt === null) return null
  try {
    const path = join(dataDir(), "sessions", "by-pid", `${ancestor.pid}.json`)
    const body = JSON.parse(readFileSync(path, "utf8")) as { session_id?: unknown; written_at?: unknown }
    if (typeof body.session_id !== "string" || !body.session_id) return null
    if (typeof body.written_at !== "number" || body.written_at < ancestor.startedAt) return null
    return body.session_id
  } catch {
    return null
  }
}

// Resolve Claude's session id: the env var, else the rendezvous (retried,
// since SessionStart and the MCP launch race), else null.
export async function resolveClaudeSessionId(
  opts: { retries?: number; delayMs?: number } = {},
): Promise<string | null> {
  const { retries = 5, delayMs = 200 } = opts
  const fromEnv = process.env[SESSION_ID_ENV]?.trim()
  if (fromEnv) return fromEnv

  const chain = ancestorChain()
  if (chain.length === 0) return null
  for (let attempt = 0; ; attempt++) {
    for (const ancestor of chain) {
      const id = readRendezvous(ancestor)
      if (id) return id
    }
    if (attempt >= retries) return null
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}

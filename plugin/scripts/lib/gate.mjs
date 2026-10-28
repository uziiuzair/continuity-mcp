import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

// Plain-ESM mirror of packages/mcp/src/gate.ts so the hooks run with zero build
// step and zero dependencies. Empty allowlist → activate in any git repo. If you
// change the normalization or hashing here, change it there too.

function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

export function normalizeRemote(url) {
  let s = (url ?? "").trim()
  if (!s) return null
  s = s.replace(/\.git$/i, "")
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i)
  if (m) return `${m[1]}/${m[2]}`.toLowerCase()
  const scp = s.match(/^[^@]+@([^:/]+):(.+)$/)
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase()
  return null
}

export function parseAllowlist(raw) {
  if (!raw || !raw.trim()) return []
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\.git$/i, ""))
    .filter(Boolean)
}

// Mirror of gate.ts identityHash. The hooks MUST derive the same cwdHash as
// the shim or they read a different state file and every gate silently fails
// open. A Claude session id is the whole identity; otherwise the legacy
// per-toplevel hash, salted by CONTINUITY_SESSION_ID when set.
function identityHash(toplevel, claudeSessionId) {
  const sessionSalt = process.env.CONTINUITY_SESSION_ID
  const hashInput = claudeSessionId
    ? `claude:${claudeSessionId}`
    : sessionSalt
      ? `${toplevel} ${sessionSalt}`
      : toplevel
  return createHash("sha256").update(hashInput).digest("hex").slice(0, 16)
}

function canonical(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Mirror of gate.ts gitLayout: one rev-parse call; stdout is salvaged from the
// error because an unborn HEAD exits non-zero after printing the other lines.
function gitLayout(dir) {
  let out
  try {
    out = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
  } catch (e) {
    out = typeof e?.stdout === "string" ? e.stdout : ""
  }
  const [toplevel, gitDir, commonDir, head] = out.split("\n").map((l) => l.trim())
  if (!toplevel || !gitDir || !commonDir) return null

  const realCommon = canonical(resolve(toplevel, commonDir))
  const isWorktree = canonical(resolve(toplevel, gitDir)) !== realCommon
  return {
    toplevel,
    worktree: {
      is_worktree: isWorktree,
      path: toplevel,
      branch: head && head !== "HEAD" ? head : null,
      main_checkout: basename(realCommon) === ".git" ? dirname(realCommon) : null,
      claude_managed: canonical(toplevel).includes("/.claude/worktrees/"),
    },
  }
}

// Hooks pass their input's session_id as opts.claudeSessionId.
export function resolveRepoContext(dir, allowlistRaw, opts = {}) {
  const layout = gitLayout(dir)
  if (!layout) return null
  const { toplevel, worktree } = layout
  const origin = git(toplevel, ["config", "--get", "remote.origin.url"])
  const normalized = normalizeRemote(origin)

  const allowlist = parseAllowlist(allowlistRaw)
  if (allowlist.length > 0) {
    if (!normalized || !allowlist.includes(normalized)) return null
  }

  const slash = normalized ? normalized.indexOf("/") : -1
  return {
    toplevel,
    repoFullName: normalized && slash >= 0 ? normalized.slice(slash + 1) : null,
    cwdHash: identityHash(toplevel, opts.claudeSessionId),
    worktree,
    repoKey: normalized ?? worktree.main_checkout ?? toplevel,
  }
}

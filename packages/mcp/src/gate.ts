import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

// Repo gate. Continuity installs user-wide, so the shim must stay inert outside
// the repos a user actually wants coordinated. Two modes:
//   - allowlist EMPTY (the default): activate in ANY git repo. Zero-config local
//     coordination works everywhere you run Claude Code in a git checkout.
//   - allowlist SET: activate only in repos whose git remote matches an entry
//     (host/owner/repo). This is how a team scopes Continuity to its repos.
// A non-git directory is always inert.

export type WorktreeInfo = {
  is_worktree: boolean
  path: string // toplevel
  branch: string | null // null when detached
  main_checkout: string | null
  claude_managed: boolean // path contains "/.claude/worktrees/"
}

export type RepoContext = {
  toplevel: string
  repoFullName: string | null // "owner/repo", best effort
  cwdHash: string
  worktree: WorktreeInfo
  // Normalized remote ("host/owner/repo") when present, else the main
  // checkout path (or the toplevel). Shared by every worktree of one repo.
  repoKey: string
}

function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// One git call for toplevel + worktree facts. A repo with no commits yet exits
// non-zero on the HEAD lookup but still prints the earlier lines, so stdout is
// read from the error too.
function gitLayout(dir: string): { toplevel: string; worktree: WorktreeInfo } | null {
  let out: string
  try {
    out = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
  } catch (e) {
    const stdout = (e as { stdout?: unknown }).stdout
    out = typeof stdout === "string" ? stdout : ""
  }
  const lines = out.split("\n").map((l) => l.trim())
  const [toplevel, gitDir, commonDir, head] = lines
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

function gitOriginUrl(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

// Normalize a git remote URL to "host/owner/repo" (lowercased, no .git suffix).
// Handles https, ssh (git@host:owner/repo), and scp-like forms.
export function normalizeRemote(url: string): string | null {
  let s = url.trim()
  if (!s) return null
  s = s.replace(/\.git$/i, "")

  // url form: scheme://[user@]host[:port]/owner/repo. Checked before the
  // scp-like form so an ssh:// URL with a port isn't misparsed as scp.
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i)
  if (m) return `${m[1]}/${m[2]}`.toLowerCase()
  // scp-like: git@github.com:owner/repo (no scheme, no ://).
  const scp = s.match(/^[^@]+@([^:/]+):(.+)$/)
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase()
  return null
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return []
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\.git$/i, ""))
    .filter(Boolean)
}

// Identity hash. With a Claude Code session id, the identity is that session
// (salted by CONTINUITY_SESSION_ID when set): stable across `cd` and worktree
// moves, distinct for two sessions in one checkout. Without one (standalone
// shim, tests), the legacy per-toplevel hash, salted the same way.
function identityHash(toplevel: string, claudeSessionId: string | null | undefined): string {
  const sessionSalt = process.env.CONTINUITY_SESSION_ID
  const hashInput = claudeSessionId
    ? sessionSalt
      ? `claude:${claudeSessionId} ${sessionSalt}`
      : `claude:${claudeSessionId}`
    : sessionSalt
      ? `${toplevel} ${sessionSalt}`
      : toplevel
  return createHash("sha256").update(hashInput).digest("hex").slice(0, 16)
}

// Returns the repo context if the shim should activate here, else null (inert).
export function resolveRepoContext(
  dir: string,
  allowlistRaw: string | undefined,
  opts: { claudeSessionId?: string | null } = {},
): RepoContext | null {
  const layout = gitLayout(dir)
  if (!layout) return null
  const { toplevel, worktree } = layout

  const origin = gitOriginUrl(toplevel)
  const normalized = origin ? normalizeRemote(origin) : null

  const allowlist = parseAllowlist(allowlistRaw)
  if (allowlist.length > 0) {
    // Scoped mode: must match an allowlisted remote.
    if (!normalized || !allowlist.includes(normalized)) return null
  }
  // Otherwise (empty allowlist) activate in any git repo, with or without a remote.

  const slash = normalized ? normalized.indexOf("/") : -1
  const repoFullName = normalized && slash >= 0 ? normalized.slice(slash + 1) : null

  return {
    toplevel,
    repoFullName,
    cwdHash: identityHash(toplevel, opts.claudeSessionId),
    worktree,
    repoKey: normalized ?? worktree.main_checkout ?? toplevel,
  }
}

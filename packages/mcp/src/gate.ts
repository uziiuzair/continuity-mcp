import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

// Repo gate. Continuity installs user-wide, so the shim must stay inert outside
// the repos a user actually wants coordinated. Two modes:
//   - allowlist EMPTY (the default): activate in ANY git repo. Zero-config local
//     coordination works everywhere you run Claude Code in a git checkout.
//   - allowlist SET: activate only in repos whose git remote matches an entry
//     (host/owner/repo). This is how a team scopes Continuity to its repos.
// A non-git directory is always inert.

export type RepoContext = {
  toplevel: string
  repoFullName: string | null // "owner/repo", best effort
  cwdHash: string
}

function gitToplevel(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
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

// Returns the repo context if the shim should activate here, else null (inert).
export function resolveRepoContext(dir: string, allowlistRaw: string | undefined): RepoContext | null {
  const toplevel = gitToplevel(dir)
  if (!toplevel) return null

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

  const sessionSalt = process.env.CONTINUITY_SESSION_ID
  const hashInput = sessionSalt ? `${toplevel} ${sessionSalt}` : toplevel
  const cwdHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16)

  return {
    toplevel,
    repoFullName,
    cwdHash,
  }
}

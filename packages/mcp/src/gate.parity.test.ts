import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { normalizeRemote, parseAllowlist, resolveRepoContext } from "./gate.js"

// Parity harness: plugin/scripts/lib/gate.mjs is a hand-maintained mirror of
// this package's gate.ts (the hooks run plain ESM with no build step). Drives
// BOTH implementations through identical inputs and asserts deep-equal
// outputs — including cwdHash — so CI fails the moment a gate.ts change (e.g.
// the CONTINUITY_SESSION_ID salt) isn't mirrored into gate.mjs. A computed
// specifier keeps tsc out of resolving the mirror; the cast to this module's
// own surface keeps the calls below type-checked.
const mirrorUrl = new URL("../../../plugin/scripts/lib/gate.mjs", import.meta.url).href
const mirror = (await import(mirrorUrl)) as typeof import("./gate.js")

// resolveRepoContext shells out to git, so parity cases that need a real git
// repo create a scratch one (mkdtemp + git init), mirroring how gate.test.ts
// exercises the real checkout via HERE = process.cwd().
function makeScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "continuity-gate-parity-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  execFileSync("git", ["remote", "add", "origin", "https://github.com/test/parity.git"], { cwd: dir })
  return dir
}

describe("parity: resolveRepoContext", () => {
  let repoDir: string | undefined

  afterEach(() => {
    delete process.env.CONTINUITY_SESSION_ID
    if (repoDir) rmSync(repoDir, { recursive: true, force: true })
    repoDir = undefined
  })

  it("agrees on cwdHash for a scratch git repo without CONTINUITY_SESSION_ID", () => {
    repoDir = makeScratchRepo()
    delete process.env.CONTINUITY_SESSION_ID
    const ts = resolveRepoContext(repoDir, undefined)
    const mj = mirror.resolveRepoContext(repoDir, undefined)
    expect(ts).not.toBeNull()
    expect(ts?.cwdHash).toMatch(/^[0-9a-f]{16}$/)
    expect(mj).toEqual(ts)
  })

  it("agrees on cwdHash with CONTINUITY_SESSION_ID set", () => {
    repoDir = makeScratchRepo()
    process.env.CONTINUITY_SESSION_ID = "sess-parity-check"
    const ts = resolveRepoContext(repoDir, undefined)
    const mj = mirror.resolveRepoContext(repoDir, undefined)
    expect(ts).not.toBeNull()
    expect(ts?.cwdHash).toMatch(/^[0-9a-f]{16}$/)
    expect(mj).toEqual(ts)
  })

  it("agrees on cwdHash with a Claude session id", () => {
    repoDir = makeScratchRepo()
    const ts = resolveRepoContext(repoDir, undefined, { claudeSessionId: "claude-parity" })
    const mj = mirror.resolveRepoContext(repoDir, undefined, { claudeSessionId: "claude-parity" })
    expect(ts?.cwdHash).toMatch(/^[0-9a-f]{16}$/)
    expect(mj).toEqual(ts)
  })

  it("agrees when a Claude session id and CONTINUITY_SESSION_ID are both set", () => {
    repoDir = makeScratchRepo()
    process.env.CONTINUITY_SESSION_ID = "sess-parity-check"
    const ts = resolveRepoContext(repoDir, undefined, { claudeSessionId: "claude-parity" })
    const mj = mirror.resolveRepoContext(repoDir, undefined, { claudeSessionId: "claude-parity" })
    expect(mj).toEqual(ts)
    // The salt applies on top of the Claude id.
    delete process.env.CONTINUITY_SESSION_ID
    expect(resolveRepoContext(repoDir, undefined, { claudeSessionId: "claude-parity" })?.cwdHash).not.toEqual(ts?.cwdHash)
  })

  it("agrees on the legacy hash for a null or empty Claude session id", () => {
    repoDir = makeScratchRepo()
    for (const claudeSessionId of [null, ""]) {
      const ts = resolveRepoContext(repoDir, undefined, { claudeSessionId })
      const mj = mirror.resolveRepoContext(repoDir, undefined, { claudeSessionId })
      expect(ts).toEqual(resolveRepoContext(repoDir, undefined))
      expect(mj).toEqual(ts)
    }
  })

  it("both return null for a non-git directory", () => {
    repoDir = mkdtempSync(join(tmpdir(), "continuity-gate-parity-nongit-"))
    expect(resolveRepoContext(repoDir, undefined)).toBeNull()
    expect(mirror.resolveRepoContext(repoDir, undefined)).toBeNull()
  })
})

describe("parity: worktree detection and repoKey", () => {
  const dirs: string[] = []
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" })

  function makeMain(remote?: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "continuity-gate-parity-wt-")))
    dirs.push(dir)
    git(dir, "init", "-q", "-b", "main")
    if (remote) git(dir, "remote", "add", "origin", remote)
    git(dir, "commit", "-q", "--allow-empty", "-m", "init")
    return dir
  }

  function expectParity(dir: string) {
    const ts = resolveRepoContext(dir, undefined)
    expect(ts).not.toBeNull()
    expect(mirror.resolveRepoContext(dir, undefined)).toEqual(ts)
    return ts
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("agrees on a main checkout", () => {
    expect(expectParity(makeMain())?.worktree.is_worktree).toBe(false)
  })

  it("agrees on a linked worktree and on repoKey with no remote", () => {
    const main = makeMain()
    const wt = `${main}-wt`
    git(main, "worktree", "add", "-q", "-b", "feat/x", wt)
    dirs.push(wt)
    const ctx = expectParity(wt)
    expect(ctx?.worktree.is_worktree).toBe(true)
    expect(ctx?.repoKey).toBe(main)
  })

  it("agrees on detached HEAD", () => {
    const main = makeMain()
    git(main, "checkout", "-q", "--detach")
    expect(expectParity(main)?.worktree.branch).toBeNull()
  })

  it("agrees on a claude-managed worktree", () => {
    const main = makeMain()
    mkdirSync(join(main, ".claude", "worktrees"), { recursive: true })
    const wt = join(main, ".claude", "worktrees", "x")
    git(main, "worktree", "add", "-q", "-b", "feat/y", wt)
    expect(expectParity(wt)?.worktree.claude_managed).toBe(true)
  })

  it("agrees on repoKey with a remote", () => {
    const main = makeMain("https://github.com/test/parity.git")
    expect(expectParity(main)?.repoKey).toBe("github.com/test/parity")
  })
})

describe("parity: normalizeRemote", () => {
  it("agrees across representative inputs", () => {
    const inputs = [
      "https://github.com/Owner/Repo", // https URL
      "git@github.com:Owner/Repo", // ssh scp-like form
      "https://github.com/owner/repo.git", // .git suffix
      "git@github.com:owner/repo.git", // scp form + .git suffix
      "ssh://git@github.com:22/owner/repo", // ssh:// with port
      "not a url",
      "",
    ]
    for (const input of inputs) {
      expect(mirror.normalizeRemote(input)).toEqual(normalizeRemote(input))
    }
  })
})

describe("parity: parseAllowlist", () => {
  it("agrees across representative inputs, including the empty allowlist", () => {
    const inputs: Array<string | undefined> = [
      undefined, // empty allowlist
      "", // empty allowlist
      "github.com/Owner/A, GitHub.com/Owner/B",
      "github.com/o/a.git, , github.com/o/b",
    ]
    for (const input of inputs) {
      expect(mirror.parseAllowlist(input)).toEqual(parseAllowlist(input))
    }
  })
})

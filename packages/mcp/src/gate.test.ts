import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { normalizeRemote, parseAllowlist, resolveRepoContext } from "./gate.js"

const HERE = process.cwd() // a real git checkout (this repo)

describe("normalizeRemote", () => {
  it("normalizes https URLs to host/owner/repo", () => {
    expect(normalizeRemote("https://github.com/Owner/Repo")).toBe("github.com/owner/repo")
  })

  it("normalizes git@ scp-like form", () => {
    expect(normalizeRemote("git@github.com:Owner/Repo")).toBe("github.com/owner/repo")
  })

  it("normalizes ssh:// URLs with a port (not misparsed as scp)", () => {
    expect(normalizeRemote("ssh://git@github.com:22/owner/repo")).toBe("github.com/owner/repo")
  })

  it("strips a trailing .git suffix", () => {
    expect(normalizeRemote("https://github.com/owner/repo.git")).toBe("github.com/owner/repo")
    expect(normalizeRemote("git@github.com:owner/repo.git")).toBe("github.com/owner/repo")
  })

  it("lowercases host and path", () => {
    expect(normalizeRemote("https://GitHub.com/UZI/MyRepo")).toBe("github.com/uzi/myrepo")
  })

  it("handles a user@ prefix in https form", () => {
    expect(normalizeRemote("https://user@gitlab.example.com/group/proj")).toBe(
      "gitlab.example.com/group/proj",
    )
  })

  it("returns null for garbage / unparseable input", () => {
    expect(normalizeRemote("not a url")).toBeNull()
    expect(normalizeRemote("")).toBeNull()
    expect(normalizeRemote("   ")).toBeNull()
    expect(normalizeRemote("/local/path/repo")).toBeNull()
  })
})

describe("parseAllowlist", () => {
  it("returns [] for undefined", () => {
    expect(parseAllowlist(undefined)).toEqual([])
  })

  it("returns [] for empty / whitespace-only strings", () => {
    expect(parseAllowlist("")).toEqual([])
    expect(parseAllowlist("   ")).toEqual([])
  })

  it("comma-splits, trims, and lowercases entries", () => {
    expect(parseAllowlist("github.com/Owner/A, GitHub.com/Owner/B")).toEqual([
      "github.com/owner/a",
      "github.com/owner/b",
    ])
  })

  it("strips trailing .git from entries and drops empty fragments", () => {
    expect(parseAllowlist("github.com/o/a.git, , github.com/o/b")).toEqual([
      "github.com/o/a",
      "github.com/o/b",
    ])
  })
})

describe("CONTINUITY_SESSION_ID override", () => {
  afterEach(() => {
    delete process.env.CONTINUITY_SESSION_ID
  })

  it("same checkout + different session ids => different cwdHash", () => {
    delete process.env.CONTINUITY_SESSION_ID
    const base = resolveRepoContext(HERE, undefined)?.cwdHash
    process.env.CONTINUITY_SESSION_ID = "sess-A"
    const a = resolveRepoContext(HERE, undefined)?.cwdHash
    process.env.CONTINUITY_SESSION_ID = "sess-B"
    const b = resolveRepoContext(HERE, undefined)?.cwdHash
    expect(a).toBeTruthy()
    expect(a).not.toEqual(b)
    expect(a).not.toEqual(base)
  })

  it("no override => stable, backwards-compatible hash", () => {
    delete process.env.CONTINUITY_SESSION_ID
    const one = resolveRepoContext(HERE, undefined)?.cwdHash
    const two = resolveRepoContext(HERE, undefined)?.cwdHash
    expect(one).toEqual(two)
    expect(one).toMatch(/^[0-9a-f]{16}$/)
  })

  it("cwdHash stays 16 hex chars with an override", () => {
    process.env.CONTINUITY_SESSION_ID = "sess-A"
    expect(resolveRepoContext(HERE, undefined)?.cwdHash).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("Claude session identity", () => {
  let otherRepo: string | undefined

  afterEach(() => {
    delete process.env.CONTINUITY_SESSION_ID
    if (otherRepo) rmSync(otherRepo, { recursive: true, force: true })
    otherRepo = undefined
  })

  it("same toplevel, different claude ids → different cwdHash", () => {
    const a = resolveRepoContext(HERE, undefined, { claudeSessionId: "claude-A" })?.cwdHash
    const b = resolveRepoContext(HERE, undefined, { claudeSessionId: "claude-B" })?.cwdHash
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(b).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toEqual(b)
    expect(a).toBe(createHash("sha256").update("claude:claude-A").digest("hex").slice(0, 16))
  })

  it("claude id hash is independent of dir", () => {
    otherRepo = mkdtempSync(join(tmpdir(), "continuity-gate-claude-"))
    execFileSync("git", ["init", "-q"], { cwd: otherRepo })
    const here = resolveRepoContext(HERE, undefined, { claudeSessionId: "claude-same" })
    const there = resolveRepoContext(otherRepo, undefined, { claudeSessionId: "claude-same" })
    expect(here?.toplevel).not.toEqual(there?.toplevel)
    expect(here?.cwdHash).toEqual(there?.cwdHash)
  })

  it("claude id wins over the CONTINUITY_SESSION_ID salt", () => {
    const plain = resolveRepoContext(HERE, undefined, { claudeSessionId: "claude-A" })?.cwdHash
    process.env.CONTINUITY_SESSION_ID = "sess-A"
    expect(resolveRepoContext(HERE, undefined, { claudeSessionId: "claude-A" })?.cwdHash).toEqual(plain)
  })

  it("no claude id → legacy hash", () => {
    delete process.env.CONTINUITY_SESSION_ID
    const ctx = resolveRepoContext(HERE, undefined)
    const legacy = createHash("sha256").update(ctx?.toplevel ?? "").digest("hex").slice(0, 16)
    expect(ctx?.cwdHash).toBe(legacy)
    expect(resolveRepoContext(HERE, undefined, { claudeSessionId: null })?.cwdHash).toBe(legacy)
    expect(resolveRepoContext(HERE, undefined, { claudeSessionId: "" })?.cwdHash).toBe(legacy)
  })
})

// Worktree detection + repoKey. Real scratch repos with a real `git worktree add`.
describe("worktree detection and repoKey", () => {
  const dirs: string[] = []
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" })

  function makeMain(remote?: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "continuity-gate-wt-")))
    dirs.push(dir)
    git(dir, "init", "-q", "-b", "main")
    if (remote) git(dir, "remote", "add", "origin", remote)
    git(dir, "commit", "-q", "--allow-empty", "-m", "init")
    return dir
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("main checkout: not a worktree, branch main, main_checkout = toplevel", () => {
    const main = makeMain()
    const ctx = resolveRepoContext(main, undefined)
    expect(ctx?.worktree).toEqual({
      is_worktree: false,
      path: main,
      branch: "main",
      main_checkout: main,
      claude_managed: false,
    })
  })

  it("linked worktree: is_worktree, its own branch, main_checkout = main toplevel", () => {
    const main = makeMain()
    const wt = join(main, "..", `${main.split("/").pop()}-wt`)
    git(main, "worktree", "add", "-q", "-b", "feat/x", wt)
    dirs.push(realpathSync(wt))
    const ctx = resolveRepoContext(wt, undefined)
    expect(ctx?.worktree.is_worktree).toBe(true)
    expect(ctx?.worktree.branch).toBe("feat/x")
    expect(ctx?.worktree.main_checkout).toBe(main)
    expect(ctx?.worktree.path).toBe(realpathSync(wt))
    expect(ctx?.worktree.claude_managed).toBe(false)
  })

  it("detached HEAD: branch is null", () => {
    const main = makeMain()
    git(main, "checkout", "-q", "--detach")
    expect(resolveRepoContext(main, undefined)?.worktree.branch).toBeNull()
  })

  it("claude_managed is true under .claude/worktrees/x", () => {
    const main = makeMain()
    mkdirSync(join(main, ".claude", "worktrees"), { recursive: true })
    const wt = join(main, ".claude", "worktrees", "x")
    git(main, "worktree", "add", "-q", "-b", "feat/y", wt)
    const ctx = resolveRepoContext(wt, undefined)
    expect(ctx?.worktree.is_worktree).toBe(true)
    expect(ctx?.worktree.claude_managed).toBe(true)
  })

  it("no remote: both worktrees share repoKey = main checkout path", () => {
    const main = makeMain()
    const wt = join(main, "..", `${main.split("/").pop()}-wt2`)
    git(main, "worktree", "add", "-q", "-b", "feat/z", wt)
    dirs.push(realpathSync(wt))
    expect(resolveRepoContext(main, undefined)?.repoKey).toBe(main)
    expect(resolveRepoContext(wt, undefined)?.repoKey).toBe(main)
  })

  it("remote: repoKey is the normalized remote", () => {
    const main = makeMain("https://github.com/test/parity.git")
    expect(resolveRepoContext(main, undefined)?.repoKey).toBe("github.com/test/parity")
  })

  it("repo without commits still resolves (unborn HEAD)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "continuity-gate-unborn-")))
    dirs.push(dir)
    git(dir, "init", "-q")
    const ctx = resolveRepoContext(dir, undefined)
    expect(ctx?.toplevel).toBe(dir)
    expect(ctx?.worktree.is_worktree).toBe(false)
  })
})

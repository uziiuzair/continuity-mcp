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

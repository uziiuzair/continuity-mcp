import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
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

  it("both return null for a non-git directory", () => {
    repoDir = mkdtempSync(join(tmpdir(), "continuity-gate-parity-nongit-"))
    expect(resolveRepoContext(repoDir, undefined)).toBeNull()
    expect(mirror.resolveRepoContext(repoDir, undefined)).toBeNull()
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

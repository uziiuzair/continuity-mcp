import { describe, expect, it } from "vitest"
import { doctorIdentityLines } from "./doctor-lines.js"

const wt = (o: object = {}) => ({ is_worktree: false, path: "/r", branch: "main", main_checkout: null, claude_managed: false, ...o })

describe("doctorIdentityLines", () => {
  it("worktree yes", () => {
    expect(doctorIdentityLines(wt({ is_worktree: true, branch: "feat/x", main_checkout: "/r/main" }), null)[0]).toBe(
      "worktree: yes (branch feat/x, main checkout /r/main)",
    )
  })
  it("worktree yes, detached", () => {
    expect(doctorIdentityLines(wt({ is_worktree: true, branch: null, main_checkout: "/r/main" }), null)[0]).toBe(
      "worktree: yes (branch detached, main checkout /r/main)",
    )
  })
  it("worktree no", () => {
    expect(doctorIdentityLines(wt(), null)[0]).toBe("worktree: no")
  })
  it("claude session id present", () => {
    expect(doctorIdentityLines(wt(), "abc-123")[1]).toBe("identity: claude session abc-123")
  })
  it("no id", () => {
    expect(doctorIdentityLines(wt(), null)[1]).toBe("identity: per-directory (no Claude session id)")
  })
})

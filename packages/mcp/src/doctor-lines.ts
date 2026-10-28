// Pure doctor-report lines about worktree + identity (kept out of index.ts so
// tests can import them without starting the server).

import type { WorktreeInfo } from "./gate.js"

export function doctorIdentityLines(worktree: WorktreeInfo, claudeSessionId: string | null): string[] {
  return [
    worktree.is_worktree
      ? `worktree: yes (branch ${worktree.branch ?? "detached"}, main checkout ${worktree.main_checkout ?? "unknown"})`
      : "worktree: no",
    claudeSessionId ? `identity: claude session ${claudeSessionId}` : "identity: per-directory (no Claude session id)",
  ]
}

# Continuity Loop & worktree awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-terminating Continuity Loop (skill, `/continuity:start`, `loop_tick` tool), per-Claude-session identity, same-repo sibling scoping, worktree detection, and hook fixes.

**Architecture:** Back-off is a pure state machine in `packages/mcp/src/loop.ts`, driven by a new `loop_tick` MCP tool that diffs coordination data against a `seen` set stored in the session state file. Identity moves from per-directory to per-Claude-`session_id` hashing in the gate (ts + mjs mirror). Worktree and repo-key info come from one `git rev-parse` call, stored as new `agent_sessions` columns in both flavors, and used to scope loop siblings to the same repo.

**Tech Stack:** TypeScript, Node ≥ 22.5 (`node:sqlite`), MCP SDK, zod, vitest, drizzle (pg, team flavor), Cloudflare Worker + Hono (server), plain-ESM hook scripts.

**Spec:** `docs/superpowers/specs/2026-10-21-continuity-loop-design.md`

## Global Constraints

- Ladder: tier 1 = 5 min × 5 quiet ticks; tier 2 = 10 min × 5 quiet ticks; tier 3 = 30 min × 2 quiet ticks then stop.
- Active tick = new inbound message (direct or broadcast), new response to a message this session sent, or new handoff for it. Decisions, file activity and session join/leave never count.
- `own_work_done`: drop one tier (1→2, 2→3; tier 3 stays tier 3, streak kept); afterwards an active tick resets to the start of the *current* tier.
- Cron prompt marker constant: `[continuity-loop]`. Full prompt: `[continuity-loop] Continuity Loop tick: call loop_tick and follow the continuity:loop skill.`
- Identity hash with a Claude session id: `sha256("claude:" + session_id).hex.slice(0, 16)`. Without one: today's `sha256(toplevel[ + " " + CONTINUITY_SESSION_ID])[:16]`.
- Hooks stay network-free on PreToolUse/Stop and fail open everywhere.
- Every gate/guard change in `packages/mcp/src/*.ts` is mirrored in `plugin/scripts/lib/*.mjs`; parity tests must cover it.
- `/continuity:start` and `continuity:loop` must NOT set `disable-model-invocation`.
- Default behavior of `agent_list_active`, plain broadcasts and the snapshot session list is unchanged; repo scoping is opt-in (`same_repo`, `scope: "repo"`).
- `plugin/mcp/index.mjs` is a committed build artifact: rebuild (`pnpm --filter @continuity/mcp build`) in any task that changes `packages/mcp` or `packages/shared` runtime code.

## Review Focus

1. **Two Claude sessions in the same checkout.** Both must get distinct session rows and state files, and see each other in `agent_list_active`. Test in Task 2.
2. **SessionStart vs. MCP launch race.** The shim may start before the SessionStart hook writes the session id. The shim must retry briefly and never adopt another session's id from a stale rendezvous file. Test in Task 1.
3. **Existing local DB from an older version.** `ALTER TABLE ADD COLUMN` must be idempotent and never fail startup on a DB that already has the columns. Test in Task 4.
4. **Stray cron after the loop stopped, or after compaction or resume.** `loop_tick` returns `no_loop`, and the Stop guard asks for a CronDelete exactly once. Test in Tasks 7 and 8.
5. **Detached HEAD or a repo with no remote.** `branch: null`, and `repo_key` falls back to the main checkout path, identically for two worktrees of the same repo. Test in Task 3.

---

### Task 0: Hotfix 0.1.0-alpha.4: stop breaking worktrees (ship first, separately)

Ships before everything else, on its own branch off `main` (`fix/worktree-hooks`), not on `feat/continuity-loop`. Afterwards, rebase `feat/continuity-loop` onto it. Source: field report 2026-10-28 (`claude --worktree` fails with `WorktreeCreate hook failed: hook succeeded but returned no worktree path`) and spec "Hook updates" items 1–2c.

**Files:**
- Delete: `plugin/scripts/worktree-create.mjs`, `plugin/scripts/worktree-remove.mjs`
- Modify: `plugin/hooks/hooks.json` (remove the `WorktreeCreate` and `WorktreeRemove` entries; add a `PostToolUse` entry with matcher `EnterWorktree|ExitWorktree`, `async: true`, running the new script), `plugin/scripts/cwd-changed.mjs`, `plugin/.claude-plugin/plugin.json` + `plugin/package.json` (version `0.1.0-alpha.4`), `.claude-plugin/marketplace.json` (version, if pinned there), `CHANGELOG.md`, `README.md`
- Create: `plugin/scripts/worktree-moved.mjs`, which runs `runShim(input.cwd || process.cwd(), ["--checkin"])`, fail-open, in the same style as `cwd-changed.mjs`

- [ ] **Step 1: Reproduce.** With the alpha.3 plugin installed, run `claude --worktree hotfix-check` in a scratch repo. Expected: `WorktreeCreate hook failed: hook succeeded but returned no worktree path`.
- [ ] **Step 2: Make the changes** listed above. `cwd-changed.mjs` uses `input.new_cwd || input.cwd || process.cwd()`. README gets a "Worktrees" note: Continuity never creates or removes worktrees; `--worktree --tmux` sessions are picked up on their first prompt.
- [ ] **Step 3: Validate** with `claude plugin validate plugin` and `pnpm test`. Expected: valid, PASS.
- [ ] **Step 4: Manual checks** (record the results in the PR):
  - `claude --worktree hotfix-check` creates `.claude/worktrees/hotfix-check`, and `.worktreeinclude` files are copied.
  - `agent_list_active` from a second session shows the worktree session.
  - In a normal session, ask Claude to `EnterWorktree`; then the session is still listed and `--doctor` from the worktree shows it active.
  - Exiting and removing the worktree deletes the directory (`ls .claude/worktrees`).
- [ ] **Step 5: Commit** `fix(plugin): stop replacing Claude Code's worktree create/remove (alpha.4)`, open a PR against `main`, and after the user merges it, rebase `feat/continuity-loop` onto `main`.

### Task 1: Spike: get Claude's `session_id` into the MCP shim

**Gate task.** If neither mechanism works reliably, STOP and report back; do not continue to Task 2.

**Files:**
- Create: `packages/mcp/src/identity.ts`, `packages/mcp/src/identity.test.ts`
- Create: `plugin/scripts/lib/identity.mjs` (rendezvous writer)
- Modify: `plugin/scripts/session-start.mjs`

**Interfaces:**
- Produces: `resolveClaudeSessionId(opts?: { retries?: number; delayMs?: number }): Promise<string | null>` in `identity.ts`. The order is: (a) an env var that Claude Code exports to MCP subprocesses, if the spike finds one; (b) rendezvous file `<dataDir>/sessions/by-pid/<pid>.json` (`{ session_id, written_at }`), looked up by walking the shim's parent-process chain (`process.ppid`, then `ps -o ppid= -p <pid>`), up to 4 levels; (c) `null`.
- Produces: `writeRendezvous(claudePid: number, sessionId: string): void` in `identity.mjs`. The SessionStart hook finds the Claude pid with the same parent-chain walk, picking the first ancestor whose `ps -o comm=` contains `claude`.

- [ ] **Step 1: Investigate.** In a real `claude` session, dump `env` from inside an MCP subprocess (temporarily log `process.env` keys from `launch.mjs` to a file under the scratch dir), and record the parent chains of an MCP subprocess and a hook process. Write the findings as a comment at the top of `identity.ts`: which env var (if any) holds the session id, and which ancestor pid both processes share.
- [ ] **Step 2: Write failing tests** in `identity.test.ts`:
  - `uses env var when present`: set the var found in Step 1, and expect `resolveClaudeSessionId()` to return it.
  - `reads rendezvous for an ancestor pid`: write `by-pid/<process.ppid>.json` into a temp `CONTINUITY_STATE_DIR`, and expect that id.
  - `retries until the rendezvous appears`: write the file after 150 ms, call with `{ retries: 5, delayMs: 100 }`, and expect the id.
  - `ignores a rendezvous older than the process`: `written_at` earlier than the ancestor's start time (`ps -o lstart=`), so expect `null`.
  - `returns null with no source`.
- [ ] **Step 3: Run** `pnpm --filter @continuity/mcp exec vitest run src/identity.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement** `identity.ts` and `identity.mjs`, then call `writeRendezvous` from `session-start.mjs` before `runShim`.
- [ ] **Step 5: Run the tests** (expect PASS), then verify end to end: start two `claude` sessions in the same checkout and confirm each shim resolves a different id (log to scratch). Record the result in the PR description.
- [ ] **Step 6: Commit** `feat(mcp): resolve Claude session id in the shim (env or pid rendezvous)`.

### Task 2: Per-session identity

**Files:**
- Modify: `packages/mcp/src/gate.ts`, `plugin/scripts/lib/gate.mjs`, `packages/mcp/src/index.ts` (`resolveRuntime`), `plugin/scripts/lib/run-shim.mjs`, every hook script that calls `resolveRepoContext` or `runShim` (`session-start`, `user-prompt-submit`, `cwd-changed`, `session-end`, `worktree-remove`, `pre-tool-use`, `post-tool-use`, `stop`, `task-created`, `task-completed`)
- Test: `packages/mcp/src/gate.test.ts`, `packages/mcp/src/gate.parity.test.ts`

**Interfaces:**
- Consumes: `resolveClaudeSessionId` (Task 1).
- Produces: `resolveRepoContext(dir: string, allowlistRaw: string | undefined, opts?: { claudeSessionId?: string | null }): RepoContext | null`. With `claudeSessionId`, `cwdHash = sha256("claude:" + id)[:16]`; otherwise the hash is unchanged. Both ts and mjs.
- Produces: `runShim(cwd, args, { timeout?, sessionId? })`, which sets env `CONTINUITY_CLAUDE_SESSION_ID` for the child. `resolveRuntime` reads that env first, then falls back to `await resolveClaudeSessionId()` (so `resolveRuntime` becomes async).

- [ ] **Step 1: Failing tests:**
  - `gate.test.ts › same toplevel, different claude ids → different cwdHash`
  - `gate.test.ts › claude id hash is independent of dir`: the same id in two dirs gives the same hash.
  - `gate.test.ts › no claude id → legacy hash` (unchanged value).
  - parity cases for both.
- [ ] **Step 2: Run** `pnpm --filter @continuity/mcp exec vitest run src/gate.test.ts src/gate.parity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** gate (ts + mjs) and `runShim` `sessionId`. Every hook passes `input.session_id` to `resolveRepoContext` / `runShim`.
- [ ] **Step 4: Run** the full mcp suite with `pnpm --filter @continuity/mcp test`. Expected: PASS.
- [ ] **Step 5: Rebuild and commit** `feat: one Continuity identity per Claude session`.

### Task 3: Worktree detection and `repo_key`

**Files:**
- Modify: `packages/mcp/src/gate.ts`, `plugin/scripts/lib/gate.mjs`
- Test: `packages/mcp/src/gate.test.ts`, `packages/mcp/src/gate.parity.test.ts`

**Interfaces:**
- Produces: `RepoContext.worktree: WorktreeInfo` and `RepoContext.repoKey: string`.
  ```ts
  export type WorktreeInfo = {
    is_worktree: boolean
    path: string            // toplevel
    branch: string | null   // null when detached
    main_checkout: string | null
    claude_managed: boolean // path contains "/.claude/worktrees/"
  }
  ```
  `repoKey` is the normalized remote when present, else `main_checkout ?? toplevel`. Use a single `git rev-parse --show-toplevel --git-dir --git-common-dir --abbrev-ref HEAD` call. Resolve `--git-dir` and `--git-common-dir` against the toplevel, then compare them with realpaths (macOS `/private` prefix, see `plugin/scripts/lib/common.mjs`).

- [ ] **Step 1: Failing tests** (scratch repos with a real `git worktree add`):
  - `main checkout: is_worktree false, branch "main", main_checkout = toplevel`
  - `linked worktree: is_worktree true, branch = new branch, main_checkout = main toplevel`
  - `detached HEAD → branch null`
  - `claude_managed true under .claude/worktrees/x`
  - `no remote: both worktrees share repoKey = main checkout path`
  - `remote: repoKey = "github.com/test/parity"`
  - parity cases for all of the above.
- [ ] **Step 2: Run** the gate tests. Expected: FAIL.
- [ ] **Step 3: Implement** (ts + mjs).
- [ ] **Step 4: Run** the gate tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(gate): detect worktrees and derive repo_key`.

### Task 4: Session columns + repo scoping, local flavor and shared types

**Files:**
- Modify: `packages/shared/src/schema.sqlite.ts` (table + `SQLITE_DDL`), `packages/shared/src/schema.pg.ts`, `packages/shared/src/schema-parity.checks.ts`, `packages/shared/src/types.ts`, `packages/shared/src/backend.ts`, `packages/shared/src/mappers.ts`, `packages/mcp/src/backends/local.ts`, `packages/mcp/src/backends/db.ts` (if migrations run there), `packages/mcp/src/index.ts` (checkin calls), `packages/mcp/src/tools/agent.ts`, `packages/mcp/src/tools/messages.ts`
- Test: `packages/mcp/src/backends/local.test.ts`

**Interfaces:**
- Consumes: `RepoContext.worktree`, `RepoContext.repoKey` (Task 3).
- Produces:
  - Columns `worktree_path TEXT`, `branch TEXT`, `is_worktree INTEGER` (0/1), and `repo_key TEXT`, all nullable. pg uses `boolean` for `is_worktree`.
  - `CheckinArgs` and heartbeat args gain optional `worktree_path`, `branch`, `is_worktree`, `repo_key`. Checkin updates these on the reuse path too.
  - `ActiveSession` and `SessionDetail` gain `worktree_path: string | null`, `branch: string | null`, `is_worktree: boolean`, `repo_key: string | null`.
  - `ListActiveArgs` gains `same_repo_key?: string`, and the backend filters on it. The tool `agent_list_active` gains `same_repo: boolean` and maps it to `ctx.repoKey`.
  - `MessageSendArgs` gains `scope?: "all" | "repo"` plus `repo_key?: string`. A repo-scoped broadcast fans out only to sessions with that `repo_key`. The tool `message_send` gains `scope`.
  - `ToolContext` gains `repoKey: string` and `worktree: WorktreeInfo`.

- [ ] **Step 1: Failing tests** in `local.test.ts`:
  - `checkin stores and returns worktree fields`
  - `re-checkin updates branch`
  - `listActive same_repo_key filters`
  - `repo-scoped broadcast skips other repos`
  - `opening a DB created by the previous DDL adds the columns` (create the old table shape first, then open)
  - `opening twice does not fail`
- [ ] **Step 2: Run** `pnpm --filter @continuity/mcp exec vitest run src/backends/local.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** For the SQLite migration, check `PRAGMA table_info(agent_sessions)` and `ALTER TABLE ... ADD COLUMN` each missing column. Extend the parity check, then thread `repo.worktree` / `repo.repoKey` into every `backend.checkin` call in `index.ts`.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm --filter @continuity/mcp test`. Expected: PASS.
- [ ] **Step 5: Rebuild and commit** `feat: worktree + repo_key on sessions, repo-scoped list/broadcast (local)`.

### Task 5: Team flavor: migration, routes, remote backend

**Files:**
- Create: `packages/server/drizzle/0003_<generated>.sql` (+ meta snapshot/journal via drizzle-kit)
- Modify: `packages/server/src/routes/agent.ts` (checkin, heartbeat, list_active), `packages/server/src/routes/handoffs.ts` (message send broadcast), `packages/mcp/src/backends/remote.ts`
- Test: `packages/mcp/src/backends/remote.test.ts`

**Interfaces:**
- Consumes: the Task 4 types.
- Produces: `GET /agent/list_active?same_repo_key=`, and body fields `worktree_path`, `branch`, `is_worktree`, `repo_key` on checkin/heartbeat. Message send accepts `scope` and `repo_key`.

- [ ] **Step 1: Failing tests** in `remote.test.ts` (it mocks fetch, following the file's pattern): the request carries the new fields and the `same_repo_key` query, and the response maps the new `ActiveSession` fields.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.** Generate the migration with `pnpm --filter @continuity/server exec drizzle-kit generate`. It must be additive only (four `ADD COLUMN`s).
- [ ] **Step 4: Run** `pnpm typecheck && pnpm --filter @continuity/mcp test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): worktree + repo_key columns and repo-scoped queries`.

### Task 6: Loop ladder state machine

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Create: `packages/mcp/src/loop.ts`, `packages/mcp/src/loop.test.ts`

**Interfaces:**
- Produces (constants): `LOOP_TIERS = [{ tier: 1, minutes: 5, quietTicks: 5 }, { tier: 2, minutes: 10, quietTicks: 5 }, { tier: 3, minutes: 30, quietTicks: 2 }] as const`, `LOOP_CRON_MARKER = "[continuity-loop]"`, `LOOP_CRON_PROMPT` (the full prompt string from Global Constraints).
- Produces (`loop.ts`):
  ```ts
  export type LoopTier = 1 | 2 | 3
  export type LoopLadder = { tier: LoopTier; quiet_streak: number; own_work_done: boolean }
  export type LoopVerdict = { action: "keep" | "reschedule" | "stop"; interval_minutes: number; cron: string; reason: string }
  export function stepLadder(prev: LoopLadder, input: { active: boolean; markDone: boolean }): { next: LoopLadder; verdict: LoopVerdict }
  export function cronFor(minutes: number): string // 5 → "*/5 * * * *", 30 → "*/30 * * * *"
  ```
  `reschedule` fires whenever the tier changes. `stop` returns the tier-3 interval and reason `"2 quiet ticks at 30 min"`.

- [ ] **Step 1: Failing tests** in `loop.test.ts`:
  - `4 quiet ticks at tier 1 → keep, streak 4`
  - `5th quiet tick at tier 1 → reschedule to 10, streak 0`
  - `5 quiet at tier 2 → reschedule to 30`
  - `2 quiet at tier 3 → stop`
  - `active at tier 2 (not done) → reschedule to 5, streak 0`
  - `active at tier 1 → keep, streak 0`
  - `markDone at tier 1 → reschedule to 10, own_work_done true`
  - `markDone at tier 3 → keep, tier 3, streak unchanged`
  - `done + active at tier 3 → keep tier 3, streak 0`
  - `done + active at tier 2 → keep tier 2, streak 0`
  - `idle total = 135 min`: simulate quiet ticks summing the intervals until stop.
  - `cronFor(10) === "*/10 * * * *"`
- [ ] **Step 2: Run** `pnpm --filter @continuity/mcp exec vitest run src/loop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): loop back-off ladder`.

### Task 7: `loop_tick` tool

**Files:**
- Create: `packages/mcp/src/tools/loop.ts`, `packages/mcp/src/tools/loop.test.ts`
- Modify: `packages/mcp/src/state.ts` (`SessionState.loop`, `SessionState.current_dir`), `plugin/scripts/lib/state.mjs` (if it has a type doc), `packages/mcp/src/index.ts` (register)

**Interfaces:**
- Consumes: `stepLadder`, `cronFor`, the `LOOP_*` constants (Task 6); `listActive({ same_repo_key })` and `messagePending`, `handoffPending`, `decisionRecent` (existing); `ToolContext.repoKey` / `worktree` (Task 4).
- Produces: `SessionState.loop` exactly as in the spec ("Where the state lives"), plus `current_dir?: string | null`.
- Produces: tool `loop_tick` with input `{ start?, task?, own_work_done?, cron_job_id? }` and the output shape from the spec. `computeTick(prev: SessionState["loop"], data: CoordinationData, input, now): { loop: NonNullable<SessionState["loop"]> | null; result: LoopTickResult }` is exported pure so it can be tested without a backend.
  - `start: true`: resets the loop (tier 1, streak 0, `seen` = current ids so existing items aren't "new"), stores `task`, verdict `reschedule` at 5 min. If a loop already exists, it returns the state unchanged with verdict `keep` (idempotent).
  - `cron_job_id` only: stores the id, no tick consumed.
  - No loop and no `start`: `{ ok: false, reason: "no_loop", hint: "CronDelete this job" }`.
  - `stop` verdict: writes `loop: null`.
  - `worktree` is resolved from `current_dir` when set (via `resolveRepoContext(current_dir)`), else `ctx.worktree`.

- [ ] **Step 1: Failing tests** for `computeTick`:
  - `start seeds seen, so pre-existing messages are not new`
  - `new inbound message → active, appears in new.messages`
  - `new resolved response → active`
  - `new handoff → active`
  - `new decision only → not active, listed in new.decisions`
  - `same-repo session joined → listed, not active`
  - `start twice → second is keep, state unchanged`
  - `no loop → no_loop`
  - `stop verdict clears loop`
  - `cron_job_id-only call does not advance streak`
- [ ] **Step 2: Run** `pnpm --filter @continuity/mcp exec vitest run src/tools/loop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and register it in `index.ts` for both flavors.
- [ ] **Step 4: Run** the full mcp suite. Expected: PASS.
- [ ] **Step 5: Rebuild and commit** `feat(mcp): loop_tick tool`.

### Task 8: Hook updates

The WorktreeCreate/WorktreeRemove removal, the `new_cwd` fix and the `EnterWorktree|ExitWorktree` hook already shipped in Task 0. This task adds the Stop guard and `current_dir` recording; `worktree-moved.mjs` (Task 0) also passes `session_id` and records `current_dir` through `--checkin`.

**Files:**
- Modify: `plugin/scripts/cwd-changed.mjs`, `plugin/scripts/worktree-moved.mjs`, `plugin/scripts/stop.mjs`, `packages/mcp/src/guard.ts`, `plugin/scripts/lib/guard.mjs`, `packages/mcp/src/index.ts` (`--checkin` writes `current_dir`)
- Test: `packages/mcp/src/guard.test.ts`, `packages/mcp/src/guard.parity.test.ts`

**Interfaces:**
- Consumes: `LOOP_CRON_MARKER` (Task 6); `SessionState.loop` (Task 7).
- Produces: `loopCronDecision(args: { loop: SessionState["loop"] | null | undefined; sessionCrons: { id: string; prompt: string }[] | undefined; stopHookActive: boolean }): { block: boolean; reason?: string; clearLoop?: boolean }` in guard.ts and its mjs mirror.
  - Loop null + one or more marked crons: block, `reason: "Continuity Loop has ended; CronDelete <ids>."`
  - Loop set + zero marked crons: `clearLoop: true`, no block.
  - Loop set + more than one marked cron: block, asking to delete every marked cron except `loop.cron_job_id`.
  - `stopHookActive` or `sessionCrons` undefined: no block.
- `stop.mjs`: runs the existing `stopGateDecision` first; if it doesn't block, runs `loopCronDecision`. `clearLoop` writes `loop: null`.
- `cwd-changed.mjs`: uses `input.new_cwd || input.cwd` and passes `session_id`; the shim's `--checkin` records `current_dir`.

- [ ] **Step 1: Failing tests** for each `loopCronDecision` case, an unmarked cron that is ignored, and parity cases.
- [ ] **Step 2: Run** `pnpm --filter @continuity/mcp exec vitest run src/guard.test.ts src/guard.parity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the guard, and pass `session_id` + record `current_dir` from the CwdChanged and worktree-moved hooks.
- [ ] **Step 4: Run** the full suite, then `claude plugin validate plugin`. Expected: PASS and valid.
- [ ] **Step 5: Commit** `feat(plugin): Stop guards orphaned loop crons; hooks record current_dir`.

### Task 9: Snapshot, deltas, doctor

**Files:**
- Modify: `packages/mcp/src/snapshot.ts`, `packages/mcp/src/deltas.ts`, `packages/mcp/src/index.ts` (`fetchCoordinationData` passes `repoKey` + loop state; `runDoctor`)
- Test: `packages/mcp/src/snapshot.test.ts`, `packages/mcp/src/deltas.test.ts`

**Interfaces:**
- Consumes: the `ActiveSession` worktree fields (Task 4) and `SessionState.loop` (Task 7).
- Produces: `renderSnapshot` data gains `repoKey: string` and `loop: SessionState["loop"] | null`.
  - Session line: `- <label> (<user>) · worktree <branch> @ <worktree_path> · "<focus>" · <ago>`. The worktree segment appears only when `is_worktree`. A same-repo session gets ` · same repo`.
  - When at least one same-repo session exists and there is no loop, add the instruction line: `- Other sessions are active in this repo: start the Continuity Loop (\`continuity:loop\` skill) unless one is already running.`
  - When a loop is running: `### Continuity Loop\n- running · tier <n> (<m> min) · quiet <streak> · cron <id>`.
  - Deltas render the same worktree segment for joined sessions.
  - Doctor: `worktree: yes (branch <b>, main checkout <p>)` or `worktree: no`, plus `identity: claude session <id>` or `identity: per-directory (no Claude session id)`.

- [ ] **Step 1: Failing tests** for each rendered line above (with and without worktree, same repo or not, with and without loop).
- [ ] **Step 2: Run** `pnpm --filter @continuity/mcp exec vitest run src/snapshot.test.ts src/deltas.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite. Expected: PASS. Check that the snapshot stays under 10,000 chars with 10 sessions, 15 files, 5 decisions, 5 handoffs, 5 messages and a loop (add a test).
- [ ] **Step 5: Rebuild and commit** `feat(snapshot): worktree + same-repo marks, loop status and start cue`.

### Task 10: Skills, command, docs

**Files:**
- Create: `plugin/skills/loop/SKILL.md`, `plugin/skills/start/SKILL.md`
- Modify: `plugin/skills/coordination/SKILL.md` (point to the loop), `README.md`, `CHANGELOG.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: `loop_tick` (Task 7), `LOOP_CRON_PROMPT` (Task 6), `message_send` `scope: "repo"` (Task 4), `agent_list_active` `same_repo` (Task 4).

- [ ] **Step 1: Write `loop/SKILL.md`.** Frontmatter `name: loop`. The `description` triggers on "other active sessions in this repo", "working in parallel with sibling sessions", "start the Continuity Loop", "a `[continuity-loop]` tick". The body covers the start sequence (`loop_tick({start, task})`, then a repo-scoped broadcast announcement with task + worktree/branch + path, then `agent_report_focus`, then `CronCreate` with the cron and `LOOP_CRON_PROMPT`, then `loop_tick({cron_job_id})`). It then covers each tick (call `loop_tick`, answer every message, act on or decline handoffs, report from `loop_tick` only and not the injected deltas, apply the verdict), the own-work-done rule (call `loop_tick({own_work_done: true})` once, then send a repo-scoped "done" note via `message_send`; `loop_tick` never sends messages itself), `no_loop` means CronDelete, and the rule that sessions sharing a checkout are fine (identity is per Claude session).
- [ ] **Step 2: Write `start/SKILL.md`.** Frontmatter `name: start`, description "Start the Continuity Loop now: announce your task, worktree and path to sibling sessions in this repo, and check Continuity on a self-backing-off schedule." `argument-hint: "[task description]"`. The body says: if `$ARGUMENTS` is given use it as the task, else summarize the current assignment; then follow the `continuity:loop` start sequence. Do not set `disable-model-invocation`.
- [ ] **Step 3: Docs.** README section "Continuity Loop" (ladder table, what counts as a reply, `/continuity:start`), CHANGELOG entry (loop, per-session identity, worktree awareness), and an architecture note on identity.
- [ ] **Step 4: Verify** with `claude plugin validate plugin`. Expected: valid, with skills `continuity:loop` and `continuity:start` listed.
- [ ] **Step 5: Commit** `feat(plugin): Continuity Loop skill and /continuity:start`.

### Task 11: End-to-end check

- [ ] **Step 1:** Run `pnpm build && pnpm typecheck && pnpm test`. Expected: all PASS.
- [ ] **Step 2:** Manual smoke. Install the plugin from the working tree, then start two `claude` sessions in the same checkout plus one in a `claude --worktree x` worktree. Confirm that each shows the other two as same-repo, the worktree session shows `worktree worktree-x @ …`, `/continuity:start` creates one marked cron, and an announcement arrives in the siblings. Then, with ticks forced (set a 1-minute ladder via a temporary local constant edit, not committed), confirm the reschedule to the second tier and the stop. Confirm that after stop, the Stop hook asks to delete a leftover cron. Record the results in the PR description.
- [ ] **Step 3:** Commit any fixes found.

# Continuity Loop & worktree awareness — design

Date: 2026-10-21
Status: draft, pending approval

## Overview

Continuity makes parallel sessions aware of each other and lets them talk, but
messages only reach a session when its human next prompts. When several agents
run unattended in parallel, the fix people reach for is a cron job ("check
Continuity every 5 minutes"). That works, but in practice every agent finishes
its work and keeps looping for hours, burning tokens on empty checks.

This feature makes the loop a first-class, self-terminating part of Continuity:

1. **Continuity Loop skill** (`continuity:loop`): what an agent does when it
   works in parallel with siblings: announce itself, then check, answer and
   report on a schedule that backs off when nothing is happening and stops on
   its own.
2. **`/continuity:start` command**: starts the same loop by hand.
3. **Worktree awareness**: Continuity detects whether a session's cwd is a git
   worktree (including Claude Code's own `.claude/worktrees/*`), records the
   worktree path and branch on the session, and shows them to siblings.
4. **Hook refresh**: bring the plugin's hooks up to date with current Claude
   Code hook capabilities (see "Hook updates").

## Goals / non-goals / anti-goals

Goals:
- An agent that discovers siblings starts the loop without being told.
- Each agent's first loop action announces its assigned task, worktree and path.
- Back-off is deterministic (computed by Continuity, not remembered by the
  model): 5m, then 10m, then 30m, then stop.
- Both flavors (local SQLite, team Worker/Neon) via the existing backend seam.

Non-goals:
- Waking an idle session from outside (the loop is how a session stays awake).
- A loop for sessions with no siblings: alone, there is nothing to check.
- Cross-repo loops.

Anti-goals (failure even if it "works"):
- Loops that outlive the work, which is the problem being solved.
- Announcements or loop chatter that trigger reply storms between agents.
- The model having to count quiet ticks itself.

## The loop

### Start

The loop starts when either:
- the SessionStart snapshot (or a later prompt-sync delta) shows other active
  sessions, and the snapshot text tells the agent to start the loop
  (`continuity:loop` skill), or
- the user runs `/continuity:start`.

Starting is idempotent: if a loop is already running for this session, start
does nothing but report its state.

On start the agent:
1. Calls `loop_tick({ start: true, task })`. Continuity resets loop state and
   returns this session's worktree, branch and path.
2. Broadcasts an announcement (`message_send({ broadcast: true, body })`,
   `requires_response: false`) naming its assigned task, worktree/branch and
   path, and calls `agent_report_focus` with the task.
3. Creates a session cron job (`CronCreate`) at the interval `loop_tick`
   returned, whose prompt is the tick instruction (`/continuity:loop tick`), and
   passes the job id back to `loop_tick({ cron_job_id })` so later ticks can
   name the job to delete.

### Each tick

1. Call `loop_tick()`. It returns everything new since the last tick: inbound
   messages, responses to messages this session sent, handoffs for this
   session, new decisions, sessions that arrived or left, plus the back-off
   verdict.
2. Answer every inbound message (`message_respond` / `message_dismiss`) and act
   on or decline handoffs.
3. Report what's new to the user in a few lines (nothing new: one line).
4. Apply the verdict: `keep` (do nothing), `reschedule` (CronDelete the old
   job, CronCreate at the new interval, pass the new id back), or `stop`
   (CronDelete, tell the user the loop ended and why).

### What counts as a reply

A tick is **active** if, since the previous tick, this session received any of:
- a new inbound message (direct or broadcast),
- a response to a message it sent,
- a new handoff addressed to it.

New decisions, file activity and sessions arriving or leaving are reported but
do **not** count as activity. Sibling announcements are broadcasts, so they do
count; that is intended (a new sibling is worth staying alert for) and cannot
storm, because announcements never require a response.

### Back-off ladder

| Tier | Interval | Quiet ticks before moving on |
| ---- | -------- | ---------------------------- |
| 1    | 5 min    | 5, then tier 2               |
| 2    | 10 min   | 5, then tier 3               |
| 3    | 30 min   | 2, then stop                 |

- An active tick resets to tier 1 with a zero quiet streak.
- **Own work done:** when the agent tells `loop_tick({ own_work_done: true })`,
  it broadcasts a short "done" note once and drops straight to the next tier
  (from tier 1 to tier 2, from tier 2 to tier 3). Once done, an active tick
  resets to the start of the *current* tier rather than to tier 1, so a
  finished agent stays responsive without going back to 5-minute checks.
- Worst case for an idle agent: 5×5 + 5×10 + 2×30 = 135 minutes, then stop.
  For a finished one: about 110 minutes.
- Ladder numbers live in `packages/shared/src/constants.ts` so tests and both
  flavors share them.

### Where the state lives

Loop state is per session, in the existing session state file
(`packages/mcp/src/state.ts`), new optional field:

```ts
loop?: {
  started_at: number
  task: string | null
  tier: 1 | 2 | 3
  quiet_streak: number
  own_work_done: boolean
  cron_job_id: string | null
  last_tick_at: number
  seen: { messages: string[]; responses: string[]; handoffs: string[]; decisions: string[]; sessions: string[] }
} | null
```

"Since the last tick" is computed by diffing ids against `seen`, mirroring the
announce-once `DeltaMemory` approach in `deltas.ts`, so it works identically
for both flavors and needs no new backend endpoint. A stopped loop sets
`loop: null`.

## The `loop_tick` tool

New MCP tool, `packages/mcp/src/tools/loop.ts`, registered for both flavors.

Input (all optional): `start: boolean`, `task: string`, `own_work_done:
boolean`, `cron_job_id: string`.

Output:

```json
{
  "ok": true,
  "session": { "id": "...", "label": "...", "worktree": { "is_worktree": true, "path": "...", "branch": "feat/x", "main_checkout": "..." } },
  "new": { "messages": [], "responses": [], "handoffs": [], "decisions": [], "sessions_joined": [], "sessions_left": [] },
  "active": false,
  "loop": { "tier": 1, "interval_minutes": 5, "quiet_streak": 3, "own_work_done": false, "cron_job_id": "..." },
  "verdict": { "action": "keep" | "reschedule" | "stop", "interval_minutes": 10, "cron": "*/10 * * * *", "reason": "5 quiet ticks at 5 min" }
}
```

`cron` is the ready-to-pass cron expression so the model never builds one.
Calling `loop_tick` without `start` and with no loop running returns
`{ ok: false, reason: "no_loop" }`, which tells a stray cron prompt to delete
itself.

## Worktree awareness

### Detection

`resolveRepoContext` (`packages/mcp/src/gate.ts`, mirrored in
`plugin/scripts/lib/gate.mjs`) gains a `worktree` field from one git call:

```
git -C <dir> rev-parse --show-toplevel --git-dir --git-common-dir --abbrev-ref HEAD
```

- `is_worktree`: `git-dir` differs from `git-common-dir` (resolved absolute).
- `path`: the toplevel.
- `branch`: `--abbrev-ref HEAD` (`HEAD` when detached becomes `null`).
- `main_checkout`: dirname of the common dir when it ends in `.git`.
- `claude_managed`: the path contains `/.claude/worktrees/`.

## Session identity: one Continuity session per Claude session (user decision)

Today identity is per directory: `cwdHash = sha256(toplevel)` unless
`CONTINUITY_SESSION_ID` salts it, and the plugin never sets that. Two Claude
sessions in one checkout share a session row and state file, so they can't
see each other. **Decision (user): separate them.** Each Claude Code session
gets its own Continuity identity, even in the same directory.

- **Identity key:** Claude Code's `session_id`. Hooks already receive it in
  every input. `cwd_hash` becomes `sha256("claude:" + session_id)[:16]`,
  stable across `cd` and worktree moves, so a session that enters a worktree
  stays the same session and updates its `worktree_path` / `branch`.
- **State file** is keyed by that hash, so hooks find it from
  `input.session_id` directly and never guess from `cwd`. This also removes the
  reviewer's orphaned-loop scenario.
- **The shim must learn `session_id`.** The MCP subprocess doesn't receive hook
  input. **The builder verifies first, as a spike, before the rest of the
  plan:** (a) whether Claude Code exposes the session id to MCP subprocesses
  (env var); if not, (b) a rendezvous: `SessionStart` writes
  `sessions/by-pid/<claude pid>.json` with the `session_id`, and the shim reads
  it from its parent-process chain, retrying briefly since SessionStart and MCP
  launch race. If neither works reliably, stop and come back. Don't fall back to
  per-directory identity silently.
- **Hook-launched shim runs** (`--snapshot`, `--prompt-sync`, `--checkin`,
  `--checkout`) receive `input.session_id` from their hook script through the
  env (`runShim`), so every process computes the same hash.
- **Resume** keeps the same `session_id`, so `--resume` keeps identity, loop
  state and crons together.
- **Fallback:** with no session id available (shim run standalone, tests),
  keep today's per-toplevel hash and `CONTINUITY_SESSION_ID` salt.
- **Migration:** none needed. Old per-directory rows expire through the
  existing idle/gone janitor.

### Storage

New nullable columns on `agent_sessions` in both flavors: `worktree_path`,
`branch`, `is_worktree` (int 0/1 in SQLite, boolean in pg), and `repo_key`
(see "Siblings are same-repo"). SQLite: added to
`SQLITE_DDL` plus an idempotent `ALTER TABLE ... ADD COLUMN` for existing DBs.
Team: drizzle migration `0003`. `schema-parity.checks.ts` extended. `checkin`
and `heartbeat` args accept the fields; `CwdChanged` and `WorktreeCreate`
re-check-in already, so a session that moves into a worktree updates itself.

### Siblings are same-repo (user decision)

Only sessions in the same repo, including its other worktrees, count as
siblings for the loop.

- `repo_key` = normalized remote (`host/owner/repo`) when there is one, else
  the main checkout path (dirname of `git-common-dir`). Worktrees of one repo
  share it.
- `listActive` gains `same_repo: boolean`. Broadcast gains `scope: "repo"`.
  Both filter on `repo_key` in both flavors, plus the server route.
- The loop uses only the repo-scoped forms: start is triggered by same-repo
  siblings, announcements and the "done" note go repo-scoped, and
  `sessions_joined/left` count same-repo sessions only.
- Default behavior of `agent_list_active`, plain broadcasts and the snapshot's
  session list is unchanged (author's call). The snapshot marks same-repo
  sessions, and the start-the-loop line appears only when one exists.

### Surfacing

- Snapshot and deltas: `- arlo-9073f6 (uzair) · worktree feat/x @ .claude/worktrees/x · "focus" · 11s ago`.
- `agent_list_active` / `agent_get` return the fields.
- `--doctor` prints `worktree: yes (branch feat/x, main checkout /path)`.

## Skill and command

- `plugin/skills/loop/SKILL.md`: `continuity:loop`. Description triggers on
  "other active sessions / working in parallel with siblings / start the
  continuity loop". Body: start, tick, reply rules, back-off, stop, and
  "tell `loop_tick` when your own work is done".
- `/continuity:start`: a user-invocable entry point that runs the loop's start
  sequence (format per current plugin conventions, see "Hook updates").
- Snapshot instructions gain one line: "Other sessions are active: start the
  Continuity Loop (`continuity:loop`) unless one is already running."

## Hook updates

Based on the current hooks reference (code.claude.com/docs/en/hooks, read
2026-10-21) and plugin skills docs.

1. **Remove the `WorktreeCreate` hook (bug fix).** A command hook on
   `WorktreeCreate` *replaces* Claude Code's default git worktree creation: its
   stdout must be the new worktree's path, and a missing path fails creation.
   Ours prints nothing and reads `worktree_path`/`path`, but the event's input
   only carries `name`. Delete the hook entry and
   `plugin/scripts/worktree-create.mjs`. Check-in on entering a worktree is
   covered by `CwdChanged`, and by `SessionStart` for `claude --worktree`.
2. **`CwdChanged` reads `new_cwd`.** The event's input has `old_cwd` /
   `new_cwd`. Use `input.new_cwd || input.cwd`.
3. **Stop hook guards the loop's cron.** Stop input now includes
   `session_crons[]` (`id`, `schedule`, `recurring`, `prompt`). The Stop script
   (network-free, reads the state file only) checks:
   - loop state is `null` but a cron whose prompt carries the loop marker
     (`[continuity-loop]`) exists: block once with "Loop has ended; CronDelete
     <id>." This kills orphaned loops, the exact hours-long failure.
   - loop is running but no marked cron exists (expired after 7 days, or lost):
     clear loop state silently. No restart nag.
   - more than one marked cron: block once asking to delete the extras.
   Respects `stop_hook_active` so it never blocks twice in a row.
4. **Ticks already get deltas.** `UserPromptSubmit` fires for scheduled-task
   prompts too, so every tick prompt already carries the `--prompt-sync` deltas.
   `loop_tick` stays the source of truth for the back-off; the deltas are a
   bonus, not a dependency.
5. **Compaction.** When a loop is running, the SessionStart snapshot (which
   also fires with `source: "compact"`) includes one line of loop state
   (tier, interval, cron id) so the agent doesn't forget it after compaction.
6. **Command format.** Plugin skills are invocable as `/<plugin>:<name>`, and
   skills are the preferred format over `commands/*.md`. So
   `plugin/skills/start/SKILL.md` becomes `/continuity:start`. It must **not**
   set `disable-model-invocation: true`: such skills don't run on scheduled
   fires, and the agent should also be able to start the loop itself. The loop
   skill is also model-invocable.

Noted, not adopted: `asyncRewake` (a background hook that exits 2 wakes an
idle session) could one day replace polling entirely, with a watcher process
that wakes the session only when a message arrives. That is a bigger design
change; the cron loop is what was asked for.

## Testing

- `loop.test.ts`: ladder transitions (quiet streaks, reset on activity,
  own-work-done tier drop, stop after two quiet 30-min ticks), `seen` diffing,
  `no_loop`, idempotent start.
- `gate.test.ts`: worktree detection against a real temp repo plus
  `git worktree add`; detached HEAD; Claude-managed path.
- Parity: `gate.parity.test.ts` covers the new field in the mjs mirror.
- Backends: new columns round-trip in local and remote tests.
- Snapshot rendering with and without worktree.

## Calls made during review (author's, not the user's)

- **Mid-session moves into a worktree.** Identity and state are keyed by
  `session_id`, so a move never orphans the loop. `CwdChanged` records the new
  cwd in the state file (`current_dir`) and re-checks in with the new worktree
  fields. `loop_tick` resolves worktree and branch from `current_dir` when it
  is set, so reports follow the move.
- **No double reporting.** Prompt-sync deltas still inject on tick prompts.
  The skill tells the agent to report from `loop_tick` only and treat the
  injected deltas as the same items.
- **Cron prompt string** is plain text, not a slash command:
  `[continuity-loop] Continuity Loop tick: call loop_tick and follow the continuity:loop skill.`
  The marker is a shared constant used by the skill, the Stop guard and tests.
- **`own_work_done` in tier 3** keeps tier 3 and its quiet streak; it never
  stops the loop on its own.

## Left to the builder

- Exact wording of the skill, the announcement and the user-facing tick report.
- Whether `loop_tick` lives in `tools/loop.ts` or extends `tools/agent.ts`.

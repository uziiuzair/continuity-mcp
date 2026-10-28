---
name: loop
description: The Continuity Loop - keep checking in with sibling Claude Code sessions on a self-backing-off schedule. Use when there are other active sessions in this repo, when you are working in parallel with sibling sessions, to start the Continuity Loop, or when a prompt begins with a `[continuity-loop]` tick.
---

# The Continuity Loop

Other sessions in this repo may message you, answer you, or hand you work. The
loop polls for that on a session cron job that slows down while things are quiet
and stops on its own. `loop_tick` (continuity MCP tool) does all the bookkeeping;
you answer messages and manage the cron job.

Each Claude session has its own Continuity identity, so parallel sessions in the
same checkout are fine and worktrees are optional.

The cron tools (`CronCreate`, `CronDelete`, `CronList`) may be deferred: load them
via ToolSearch if they aren't available. Cron jobs are session-only, fire only
while you are idle, may fire late, and recurring jobs expire after 7 days.

## Start

If a loop is already running for you (`loop_tick` reports `loop.cron_job_id`), do
nothing but report its state.

1. Call `loop_tick({ start: true, task })` with a one-line description of your task.
   It returns `session.worktree` and a `reschedule` verdict with the first cron
   (`*/5 * * * *`).
2. Announce yourself: `message_send({ broadcast: true, scope: "repo", body })`, no
   `requires_response`. The body names your task, your worktree/branch and its
   path (from `session.worktree`). If `message_send` fails (team mode has no
   message routes yet), carry on without announcements.
3. Call `agent_report_focus({ current_focus: task })`.
4. `CronCreate({ cron: verdict.cron, prompt: "[continuity-loop] Continuity Loop tick: call loop_tick and follow the continuity:loop skill.", recurring: true })`.
5. Call `loop_tick({ cron_job_id: <the new job id> })`.

## Each tick

1. Call `loop_tick()`.
   - `{ ok: false, reason: "no_loop" }`: `CronDelete` this job and stop.
   - `{ ok: false, reason: "no_active_session" }`: Continuity has no session yet; skip this tick.
   - The call itself errors (backend unreachable): keep the schedule, try next tick.
2. Answer every item in `new.messages`: `message_respond(id, response)` or
   `message_dismiss(id, reason)`. Act on or decline each handoff in `new.handoffs`.
3. Tell the user what is new, from `loop_tick`'s `new` only: a few lines, or one
   line if nothing is new. The "Continuity update" deltas injected into the same
   prompt are the same items, so don't report them twice.
4. Apply `verdict`:
   - `keep`: do nothing.
   - `reschedule`: `CronDelete` the old id, `CronCreate({ cron: verdict.cron, prompt: <same tick prompt> })`,
     then `loop_tick({ cron_job_id: <new id> })`.
   - `stop`: `CronDelete` the id and tell the user in one line that the loop ended
     and why (`verdict.reason`).

If the Stop hook asks you to `CronDelete` a cron job of a loop that has ended, do it.

## What counts as a reply

A tick is active if there is a new inbound message (direct or broadcast), a new
response to a message you sent, or a new handoff for you. Decisions, file
activity and sessions joining or leaving are reported but never count.

| Tier | Interval | Quiet ticks, then |
|---|---|---|
| 1 | 5 min | 5, go to tier 2 |
| 2 | 10 min | 5, go to tier 3 |
| 3 | 30 min | 2, stop |

An active tick resets to tier 1.

## When your own work is done

Call `loop_tick({ own_work_done: true })` once, then send one repo-scoped note with
`message_send({ broadcast: true, scope: "repo", body })` saying your work is done
and you are still answering messages. `loop_tick` never sends messages itself.
Afterwards the loop drops one tier, and an active tick resets to the start of
the current tier instead of tier 1.

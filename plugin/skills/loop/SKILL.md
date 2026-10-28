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

1. Call `loop_tick({ start: true, task })` with a one-line description of your task.
   Starting is idempotent. If it errors or returns `ok: false`, tell the user in one
   line and don't create a cron job. If a loop already exists, don't announce again:
   - It returns `keep` and the current `loop.cron_job_id`: call `CronList`. If a job
     whose prompt has the `[continuity-loop]` marker exists, report the loop's state
     and stop here. If none does, the cron is gone: do steps 4 and 5 below.
   - It returns `reschedule` with reason `loop running, no cron recorded`: call
     `CronList`. If a `[continuity-loop]` job exists, pass its id with
     `loop_tick({ cron_job_id })`; otherwise do steps 4 and 5 below.

   For a new loop it returns `session.worktree` and a `reschedule` verdict with the
   first cron (`*/5 * * * *`).
2. Announce yourself: `message_send({ broadcast: true, scope: "repo", body })`, no
   `requires_response`. The body names your task and the branch and path from
   `session.worktree` (if `is_worktree` is false, that is the plain checkout's
   `branch` and `path`). If `message_send` fails (team mode has no message routes
   yet), carry on without announcements.
3. Call `agent_report_focus({ current_focus: task })`.
4. `CronCreate({ cron: verdict.cron, prompt: "[continuity-loop] Continuity Loop tick: call loop_tick and follow the continuity:loop skill.", recurring: true })`.
5. Call `loop_tick({ cron_job_id: <the new job id> })`.

## Each tick

1. Call `loop_tick()`.
   - `{ ok: false, reason: "no_loop" }`: call `CronList`, then `CronDelete` every job whose prompt has the `[continuity-loop]` marker (this includes the one that fired this tick), and stop.
   - `{ ok: false, reason: "no_active_session" }`: Continuity has no session yet; skip this tick.
   - The call itself errors (backend unreachable): keep the schedule, try next tick.
2. Answer every item in `new.messages`: `message_respond(id, response)` or
   `message_dismiss(id, reason)`. Act on or decline each handoff in `new.handoffs`.
3. Tell the user what is new, from `loop_tick`'s `new` only: a few lines, or one
   line if nothing is new. The "Continuity update" deltas injected into the same
   prompt are the same items, so don't report them twice.
4. Apply `verdict`:
   - `keep`: do nothing.
   - `reschedule`: `CronDelete` the old id (`loop.cron_job_id` from the previous
     `loop_tick` result), `CronCreate({ cron: verdict.cron, prompt: "[continuity-loop] Continuity Loop tick: call loop_tick and follow the continuity:loop skill.", recurring: true })`,
     then `loop_tick({ cron_job_id: <new id> })`.
   - `stop`: `CronDelete` the id (`loop.cron_job_id`) and tell the user in one line that the loop ended
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

Call `loop_tick({ own_work_done: true })` once. It is a real tick: handle `new` and
apply the returned `verdict` exactly as in a normal tick (answer messages, handle
handoffs, report, then keep/reschedule/stop; it usually reschedules because it drops
a tier). Then send one repo-scoped note with
`message_send({ broadcast: true, scope: "repo", body })` saying your work is done
and you are still answering messages; if that fails in team mode, carry on.
`loop_tick` never sends messages itself. Afterwards an active tick resets to the
start of the current tier instead of tier 1.

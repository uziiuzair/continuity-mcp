import { runWeeklyDigest } from "./digest.js"
import { runGitHubSync } from "./github-sync.js"
import { runJanitor } from "./janitor.js"
import type { Bindings } from "./types.js"

// Cron dispatcher. wrangler.toml registers two triggers:
//   "* * * * *"   — every minute: janitor + GitHub Projects sync/reconcile
//   "0 9 * * 1"   — Mondays 09:00 UTC: weekly digest
//
// The GitHub sync and weekly digest are team-flavor extras: both no-op when
// their integrations aren't configured, so the minute tick stays correct on a
// minimal deploy.
export async function handleScheduled(
  event: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  if (event.cron === "0 9 * * 1") {
    ctx.waitUntil(runWeeklyDigest(env).then(() => undefined))
    return
  }
  // Default minute tick.
  ctx.waitUntil(runJanitor(env))
  ctx.waitUntil(runGitHubSync(env))
}

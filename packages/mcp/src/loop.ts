/**
 * Continuity Loop back-off ladder. Pure state machine: no I/O.
 * `loop_tick` calls `stepLadder` once per tick.
 */
import { LOOP_TIERS } from "@continuity/shared"

export type LoopTier = 1 | 2 | 3
export type LoopLadder = { tier: LoopTier; quiet_streak: number; own_work_done: boolean }
export type LoopVerdict = {
  action: "keep" | "reschedule" | "stop"
  interval_minutes: number
  cron: string
  reason: string
}

export function cronFor(minutes: number): string {
  return `*/${minutes} * * * *`
}

const spec = (tier: LoopTier) => LOOP_TIERS[tier - 1] as (typeof LOOP_TIERS)[number]

function verdict(
  prevTier: LoopTier,
  next: LoopLadder,
  reason: string,
  stop = false,
): LoopVerdict {
  const minutes = spec(next.tier).minutes
  const action = stop ? "stop" : next.tier !== prevTier ? "reschedule" : "keep"
  return { action, interval_minutes: minutes, cron: cronFor(minutes), reason }
}

export function stepLadder(
  prev: LoopLadder,
  input: { active: boolean; markDone: boolean },
): { next: LoopLadder; verdict: LoopVerdict } {
  let cur: LoopLadder = { ...prev }
  const dropping = input.markDone && !prev.own_work_done

  if (dropping) {
    cur = { ...cur, own_work_done: true }
    if (cur.tier < 3) {
      cur = { ...cur, tier: (cur.tier + 1) as LoopTier, quiet_streak: 0 }
    }
    // A tick where markDone applies never advances the quiet streak.
    if (!input.active) {
      const reason =
        cur.tier !== prev.tier
          ? `own work done: dropped to ${spec(cur.tier).minutes} min`
          : "own work done: already at slowest tier"
      return { next: cur, verdict: verdict(prev.tier, cur, reason) }
    }
  }

  if (input.active) {
    const done = cur.own_work_done
    const next: LoopLadder = { ...cur, tier: done ? cur.tier : 1, quiet_streak: 0 }
    const reason = done
      ? `activity: staying at ${spec(next.tier).minutes} min`
      : `activity: reset to ${spec(1).minutes} min`
    return { next, verdict: verdict(prev.tier, next, reason) }
  }

  // Quiet tick.
  const streak = cur.quiet_streak + 1
  const { quietTicks, minutes } = spec(cur.tier)
  if (streak < quietTicks) {
    const next = { ...cur, quiet_streak: streak }
    return {
      next,
      verdict: verdict(prev.tier, next, `quiet ${streak}/${quietTicks} at ${minutes} min`),
    }
  }
  if (cur.tier === 3) {
    const next = { ...cur, quiet_streak: streak }
    return { next, verdict: verdict(prev.tier, next, `${quietTicks} quiet ticks at ${minutes} min`, true) }
  }
  const next: LoopLadder = { ...cur, tier: (cur.tier + 1) as LoopTier, quiet_streak: 0 }
  return {
    next,
    verdict: verdict(prev.tier, next, `${quietTicks} quiet ticks at ${minutes} min: slowing to ${spec(next.tier).minutes} min`),
  }
}

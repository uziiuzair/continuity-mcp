// Dialect-neutral timestamp handling.
//
// Postgres (team flavor) returns `Date` for timestamptz columns; SQLite (local
// flavor) stores ISO-8601 `text`. Every serializer normalizes through `toIso`
// so one row→DTO mapper works for both. SQLite timestamps are stored as ISO
// strings precisely so they sort lexicographically (= chronologically).

export type TimestampLike = Date | string | number

export function toIso(v: TimestampLike): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "number") return new Date(v).toISOString()
  // Already an ISO string (SQLite path). Trust it; normalize via Date only if
  // it doesn't look like an ISO timestamp, to avoid corrupting precision.
  return v
}

export function toIsoOrNull(v: TimestampLike | null | undefined): string | null {
  return v == null ? null : toIso(v)
}

/** Current time as an ISO-8601 string (the canonical SQLite storage form). */
export function nowIso(): string {
  return new Date().toISOString()
}

/** Milliseconds elapsed since a timestamp, relative to `now` (default: now). */
export function msSince(v: TimestampLike, now: number = Date.now()): number {
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v)
  return now - t
}

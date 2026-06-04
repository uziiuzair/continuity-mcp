import type { Bindings } from "./types.js"

// Thin Slack incoming-webhook client. Returns false (rather than throwing) when
// no SLACK_WEBHOOK_URL is configured or the post fails, so callers can fall back
// (e.g. to a `needs-human` GitHub issue) without special-casing errors. Slack is
// OPTIONAL — the Worker deploys and escalations still record an audit row
// without it.
export async function postSlack(env: Bindings, text: string): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) return false
  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
    return res.ok
  } catch {
    return false
  }
}

import { pgSchema } from "@continuity/shared"
import { neon } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-http"

export type Db = ReturnType<typeof makeDb>

export function makeDb(connectionString: string) {
  const sql = neon(connectionString)
  return drizzle(sql, { schema: pgSchema })
}

// HMAC-SHA256 of the raw API key with a server-side secret.
//
// API keys are looked up on every request, so we need deterministic, fast
// hashing for an indexed equality lookup. Keys are 256-bit random (not human
// passwords), so the brute-force resistance bcrypt provides isn't the concern.
// The server-side secret means a DB-only leak still can't forge keys.
// Web Crypto works in both Workers and Node 19+.
export async function hashApiKey(rawKey: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawKey))
  return toHex(new Uint8Array(sig))
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

import { pgSchema } from "@continuity/shared"
import { eq } from "drizzle-orm"
import type { MiddlewareHandler } from "hono"
import { hashApiKey, makeDb } from "./db.js"
import type { AppEnv } from "./types.js"

// Bearer-token auth. The raw key is HMAC-hashed and matched against
// users.api_key_hash. The DB client is created here and shared via context so
// route handlers reuse one connection per request.
export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization")
  const rawKey = header?.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!rawKey) return c.json({ error: "missing_authorization" }, 401)

  const hash = await hashApiKey(rawKey, c.env.API_KEY_HMAC_SECRET)
  const db = makeDb(c.env.DATABASE_URL)
  const found = await db
    .select({ id: pgSchema.users.id })
    .from(pgSchema.users)
    .where(eq(pgSchema.users.apiKeyHash, hash))
    .limit(1)

  const user = found[0]
  if (!user) return c.json({ error: "invalid_api_key" }, 401)

  c.set("userId", user.id)
  c.set("db", db)
  await next()
}

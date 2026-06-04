// Issue a teammate API key. Usage:
//   DATABASE_URL=... API_KEY_HMAC_SECRET=... \
//     pnpm --filter @continuity/server user:create <email> <name> [github_username]
//
// Generates a 256-bit random key, stores only its HMAC hash, and prints the raw
// key once — it's never recoverable afterward.
import { randomBytes } from "node:crypto"
import { pgSchema } from "@continuity/shared"
import { hashApiKey, makeDb } from "../src/db.js"

async function main(): Promise<void> {
  const [email, name, githubUsername] = process.argv.slice(2)
  if (!email || !name) {
    console.error("usage: user:create <email> <name> [github_username]")
    process.exit(1)
  }
  const databaseUrl = process.env.DATABASE_URL
  const secret = process.env.API_KEY_HMAC_SECRET
  if (!databaseUrl || !secret) {
    console.error("DATABASE_URL and API_KEY_HMAC_SECRET must be set")
    process.exit(1)
  }

  const rawKey = randomBytes(32).toString("hex")
  const apiKeyHash = await hashApiKey(rawKey, secret)
  const db = makeDb(databaseUrl)
  const inserted = await db
    .insert(pgSchema.users)
    .values({ email, name, apiKeyHash, githubUsername: githubUsername ?? null })
    .returning({ id: pgSchema.users.id })

  console.log(`Created user ${name} <${email}> (id ${inserted[0]?.id})`)
  console.log("\nAPI key (store it now — it will not be shown again):\n")
  console.log(`  ${rawKey}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

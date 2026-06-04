import { defineConfig } from "drizzle-kit"

// Generates Postgres migrations from the shared schema. Run:
//   pnpm --filter @continuity/server db:generate
//   pnpm --filter @continuity/server db:push   (applies to DATABASE_URL)
export default defineConfig({
  dialect: "postgresql",
  schema: "../shared/src/schema.pg.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
})

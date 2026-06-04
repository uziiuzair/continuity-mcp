// @continuity/shared — public surface.
//
// Dialect-free building blocks for both flavors: wire DTOs, the ContinuityBackend
// interface, row→DTO mappers, status derivation, constants, and the two Drizzle
// schemas. Dialect-specific query execution lives in each backend (packages/mcp)
// and the Worker (packages/server).

export const SHARED_PACKAGE_VERSION = "0.1.0"

export * from "./types.js"
export * from "./constants.js"
export * from "./time.js"
export * from "./status.js"
export * from "./mappers.js"
export * from "./backend.js"

// Schemas are exported under namespaces to avoid identifier collisions (both
// define `agentSessions`, `decisions`, ...). Import the one your dialect needs:
//   import { pgSchema } from "@continuity/shared"   // team flavor
//   import { sqliteSchema } from "@continuity/shared" // local flavor
export * as pgSchema from "./schema.pg.js"
export * as sqliteSchema from "./schema.sqlite.js"

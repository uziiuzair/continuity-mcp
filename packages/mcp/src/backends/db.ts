// Local SQLite connection for the local flavor, on Node's built-in node:sqlite
// (DatabaseSync). No native addon — the plugin payload is pure JS and works on
// any OS/arch. Requires Node >= 22 (launched with --experimental-sqlite on
// 22.x–23.x; unflagged on 24+).
//
// Parallel Claude Code sessions each spawn their own shim process pointing at
// one shared DB file. WAL + busy_timeout is what makes that multi-process access
// safe: writers don't block readers, and a momentarily-locked writer retries.
//
// node:sqlite is loaded via createRequire (not a static import) so test runners
// whose bundled node-builtins list predates node:sqlite don't choke on it; a
// type-only import keeps full typing. esbuild bundles it as external regardless.

import { mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { sqliteSchema } from "@continuity/shared"

const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite")

export type LocalDb = DatabaseSync

export function openLocalDb(path: string): LocalDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSyncCtor(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA foreign_keys = ON")
  // Idempotent table + index creation (zero-config: no migration step). The DDL
  // also carries the partial UNIQUE indexes + CHECK constraints.
  db.exec(sqliteSchema.SQLITE_DDL)
  return db
}

import { defineConfig } from "vitest/config"

// node:sqlite needs --experimental-sqlite on Node 22.x–23.x (a no-op on 24+),
// including inside vitest's worker processes — without this the local-backend
// suite can't even load on the documented minimum Node version.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
})

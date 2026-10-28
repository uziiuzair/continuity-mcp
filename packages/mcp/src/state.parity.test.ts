import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { dataDir, stateFilePath } from "./state.js"

// plugin/scripts/lib/state.mjs is the hooks' plain-ESM mirror of state.ts. The
// state file is the rendezvous between the hooks and the shim, so both must
// resolve the same path for every data-dir branch. A computed specifier keeps
// tsc out of resolving the mirror.
const mirrorUrl = new URL("../../../plugin/scripts/lib/state.mjs", import.meta.url).href
const mirror = (await import(mirrorUrl)) as Pick<typeof import("./state.js"), "dataDir" | "stateFilePath">

const KEYS = ["CONTINUITY_STATE_DIR", "CLAUDE_PLUGIN_DATA"] as const
let saved: Partial<Record<(typeof KEYS)[number], string>>

beforeEach(() => {
  saved = {}
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("parity: state file path (shim state.ts vs hooks state.mjs)", () => {
  it("CONTINUITY_STATE_DIR wins over CLAUDE_PLUGIN_DATA", () => {
    process.env.CONTINUITY_STATE_DIR = "/tmp/continuity-own-state"
    process.env.CLAUDE_PLUGIN_DATA = "/tmp/continuity-plugin-data"
    expect(dataDir()).toBe("/tmp/continuity-own-state")
    expect(mirror.dataDir()).toBe(dataDir())
    expect(mirror.stateFilePath("abc123")).toBe(stateFilePath("abc123"))
  })

  it("CLAUDE_PLUGIN_DATA when CONTINUITY_STATE_DIR is unset or blank", () => {
    process.env.CLAUDE_PLUGIN_DATA = "/tmp/continuity-plugin-data"
    expect(mirror.stateFilePath("abc123")).toBe(stateFilePath("abc123"))
    process.env.CONTINUITY_STATE_DIR = "   "
    expect(dataDir()).toBe("/tmp/continuity-plugin-data")
    expect(mirror.stateFilePath("abc123")).toBe(stateFilePath("abc123"))
  })

  it("default path when neither is set", () => {
    expect(dataDir()).toBe(join(homedir(), ".claude", "plugins", "data", "continuity"))
    expect(mirror.dataDir()).toBe(dataDir())
    expect(mirror.stateFilePath("abc123")).toBe(stateFilePath("abc123"))
  })
})

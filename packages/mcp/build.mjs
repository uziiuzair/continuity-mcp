// Bundle the MCP shim to a single ESM file and stage it as the plugin payload.
//
// The local backend uses Node's built-in node:sqlite (no native addon), so the
// bundle is pure JS — the plugin payload is just one file, cross-platform, and
// installs with no node_modules. node:sqlite is a Node builtin and stays
// external automatically. Requires Node >= 22 at runtime (the launcher passes
// --experimental-sqlite for 22.x–23.x; it's unflagged on 24+).

import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = dirname(fileURLToPath(import.meta.url))
const production = process.argv.includes("production")

await build({
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(root, "dist/index.mjs"),
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  minify: production,
  sourcemap: !production,
  logLevel: "info",
})

// Stage the (pure-JS) bundle as the committed plugin payload. No node_modules.
const pluginMcp = join(root, "..", "..", "plugin", "mcp")
rmSync(join(pluginMcp, "node_modules"), { recursive: true, force: true }) // drop any legacy native copy
mkdirSync(pluginMcp, { recursive: true })
cpSync(join(root, "dist/index.mjs"), join(pluginMcp, "index.mjs"))
console.log("Plugin payload → plugin/mcp/index.mjs (pure JS, no native deps)")

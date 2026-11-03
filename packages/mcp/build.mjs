// Bundle the MCP shim to ESM and stage it as the plugin payload.
//
// The local backend uses Node's built-in node:sqlite (no native addon), so the
// bundle is pure JS — the plugin payload is a handful of files, cross-platform,
// and installs with no node_modules. node:sqlite is a Node builtin and stays
// external automatically. Requires Node >= 22 at runtime (the launcher passes
// --experimental-sqlite for 22.x–23.x; it's unflagged on 24+).
//
// Two things keep the payload reviewable by the plugin directory's validator:
//   - ajv is stubbed out. The SDK's Server imports it unconditionally, but only
//     uses it to validate elicitation responses, which Continuity never sends.
//     Bundling it would ship a code generator (`new Function`) and a remote
//     schema URL for nothing.
//   - Vendor code is split into its own chunks (via extra entry points), so no
//     single file exceeds the validator's 256 KiB inspection limit.

import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = dirname(fileURLToPath(import.meta.url))
const production = process.argv.includes("production")
const MAX_FILE_BYTES = 256 * 1024

const noAjv = {
  name: "no-ajv",
  setup(b) {
    b.onResolve({ filter: /\/validation\/ajv-provider\.js$/ }, () => ({ path: "ajv-provider", namespace: "no-ajv" }))
    b.onLoad({ filter: /.*/, namespace: "no-ajv" }, () => ({
      loader: "js",
      contents: `export class AjvJsonSchemaValidator {
        getValidator() { throw new Error("[continuity] JSON-schema validation (elicitation) is not bundled") }
      }`,
    }))
  },
}

rmSync(join(root, "dist"), { recursive: true, force: true })
await build({
  entryPoints: [
    { in: join(root, "src/index.ts"), out: "index" },
    // Not loaded directly — they exist so esbuild splits vendor code into chunks.
    { in: "zod", out: "vendor/zod" },
    { in: "@modelcontextprotocol/sdk/server/mcp.js", out: "vendor/mcp-sdk" },
  ],
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  chunkNames: "chunks/[name]-[hash]",
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  plugins: [noAjv],
  minify: production,
  sourcemap: !production,
  logLevel: "info",
})

const files = (dir) =>
  readdirSync(dir, { recursive: true })
    .map((f) => join(dir, f))
    .filter((f) => f.endsWith(".mjs") && statSync(f).isFile())
for (const f of files(join(root, "dist"))) {
  const size = statSync(f).size
  if (size > MAX_FILE_BYTES) throw new Error(`${f} is ${size} bytes — over the plugin validator's 256 KiB limit`)
}

// Stage the (pure-JS) bundle as the committed plugin payload. No node_modules.
// Everything in plugin/mcp except launch.mjs is build output, so clear it first.
const pluginMcp = join(root, "..", "..", "plugin", "mcp")
mkdirSync(pluginMcp, { recursive: true })
for (const f of readdirSync(pluginMcp)) {
  if (f !== "launch.mjs") rmSync(join(pluginMcp, f), { recursive: true, force: true })
}
cpSync(join(root, "dist"), pluginMcp, { recursive: true, filter: (src) => !src.endsWith(".map") })
console.log("Plugin payload → plugin/mcp/ (pure JS, no native deps)")

#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist",
  format: "esm",
  external: ["jsonc-parser"],
  define: {
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
})

console.log("Build complete")

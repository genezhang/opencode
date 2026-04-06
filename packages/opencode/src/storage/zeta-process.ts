/**
 * Manages a local Zeta subprocess for embedded Zengram mode.
 *
 * When OPENCODE_STORAGE=zengram and no external ZENGRAM_HOST is set, this
 * module finds the Zeta binary, downloads the BAAI/bge-small-en-v1.5 ONNX
 * embedding model files (if absent), and spawns Zeta as a managed subprocess
 * on a local port. The subprocess is automatically killed on process exit.
 *
 * Binary lookup order:
 *   1. ZETA_BIN environment variable
 *   2. <opencode-cache-bin>/zeta  (bundled optional dep, future)
 *   3. `zeta` in PATH
 */

import { spawn, type ChildProcess } from "child_process"
import net from "net"
import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "zeta-process" })

/** Data directory for the managed Zeta instance. */
export const ZETA_DATA_DIR = path.join(Global.Path.data, "zeta")
const EMBED_DIR = path.join(ZETA_DATA_DIR, "embed")

/**
 * Model files for BAAI/bge-small-en-v1.5 (384-dim, optimum ONNX export).
 * Zeta's embed() SQL function loads these from {data_dir}/embed/ at startup.
 */
const MODEL_FILES: Record<string, string> = {
  "model.onnx":
    "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/onnx/model.onnx",
  "vocab.txt":
    "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/vocab.txt",
}

let _proc: ChildProcess | null = null
let _port: number | null = null

// ── Binary discovery ──────────────────────────────────────────────────────────

async function findZetaBinary(): Promise<string | null> {
  // 1. Explicit override via environment variable.
  if (process.env.ZETA_BIN) {
    try {
      await fs.access(process.env.ZETA_BIN)
      return process.env.ZETA_BIN
    } catch {
      log.warn("ZETA_BIN is set but not accessible", { path: process.env.ZETA_BIN })
    }
  }

  // 2. Bundled alongside OpenCode in the cache bin directory.
  const bundled = path.join(Global.Path.bin, "zeta")
  try {
    await fs.access(bundled)
    return bundled
  } catch {}

  // 3. `zeta` in PATH — probe with --help (exits 0).
  const found = await new Promise<boolean>((resolve) => {
    const p = spawn("zeta", ["--help"], { stdio: "ignore" })
    p.on("exit", (code) => resolve(code === 0))
    p.on("error", () => resolve(false))
  })
  if (found) return "zeta"

  return null
}

// ── Port utilities ────────────────────────────────────────────────────────────

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo
      srv.close(() => resolve(addr.port))
    })
    srv.on("error", reject)
  })
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ port, host: "127.0.0.1" })
      sock.once("connect", () => {
        sock.destroy()
        resolve(true)
      })
      sock.once("error", () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`Zeta did not accept connections on port ${port} within ${timeoutMs}ms`)
}

// ── Model file download ───────────────────────────────────────────────────────

/**
 * Download BAAI/bge-small-en-v1.5 ONNX model files into {data_dir}/embed/.
 *
 * Skips files that are already present. Uses atomic write (temp file + rename)
 * so a partial download never leaves a corrupt file on disk. Safe to call
 * concurrently or multiple times.
 *
 * Called fire-and-forget from ensureZeta() so startup is not blocked.
 * Until the files are present, Zeta's embed() returns an error and knowledge
 * recall falls back to keyword (ILIKE) search automatically.
 */
export async function ensureModelFiles(): Promise<void> {
  await fs.mkdir(EMBED_DIR, { recursive: true })

  for (const [filename, url] of Object.entries(MODEL_FILES)) {
    const dest = path.join(EMBED_DIR, filename)

    // Skip if already present.
    try {
      await fs.access(dest)
      log.info("model file already present", { filename })
      continue
    } catch {}

    process.stderr.write(`[opencode] Downloading embedding model: ${filename} ...\n`)
    log.info("downloading model file", { filename, url })

    const resp = await fetch(url, { redirect: "follow" })
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} downloading ${url}`)
    }

    const buf = Buffer.from(await resp.arrayBuffer())
    const tmp = dest + ".tmp"
    await fs.writeFile(tmp, buf)
    await fs.rename(tmp, dest)

    process.stderr.write(
      `[opencode] Model file ready: ${filename} (${(buf.length / 1024 / 1024).toFixed(1)} MB)\n`,
    )
    log.info("model file downloaded", { filename, bytes: buf.length })
  }
}

// ── Subprocess lifecycle ──────────────────────────────────────────────────────

async function spawnZeta(bin: string, dataDir: string, port: number): Promise<void> {
  const args = [
    "--data-dir", dataDir,
    "--port", String(port),
    "--bind", "127.0.0.1",
    "--storage-backend", "lsm",
    "--block-cache-mb", "128",
  ]

  log.info("spawning zeta", { bin, dataDir, port })

  _proc = spawn(bin, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  })

  _proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trimEnd()
    log.info("zeta", { line })
  })

  _proc.on("exit", (code, signal) => {
    log.info("zeta subprocess exited", { code, signal })
    _proc = null
    _port = null
  })

  _proc.on("error", (err) => {
    log.error("zeta subprocess error", { err })
  })

  // Ensure the subprocess is killed when OpenCode exits.
  const cleanup = () => {
    if (_proc) {
      log.info("killing zeta subprocess on exit")
      _proc.kill("SIGTERM")
      _proc = null
    }
  }
  process.once("exit", cleanup)
  process.once("SIGINT", () => {
    cleanup()
    process.exit(130)
  })
  process.once("SIGTERM", () => {
    cleanup()
    process.exit(143)
  })

  await waitForPort(port)
  log.info("zeta ready", { port })
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Ensure a local Zeta instance is running and accepting connections.
 *
 * Returns the port number of the local instance, or null if:
 *   - An external ZENGRAM_HOST is configured (not localhost)
 *   - No Zeta binary was found
 *
 * When null is returned the caller should use whatever ZENGRAM_HOST/PORT
 * env vars are set to connect to an external server.
 */
export async function ensureZeta(): Promise<number | null> {
  // Already running.
  if (_proc && _port !== null) return _port

  // External server explicitly configured — don't manage locally.
  const extHost = process.env.ZENGRAM_HOST
  if (extHost && extHost !== "127.0.0.1" && extHost !== "localhost") {
    return null
  }

  const bin = await findZetaBinary()
  if (!bin) {
    log.warn("no zeta binary found; set ZETA_BIN env or add `zeta` to PATH")
    return null
  }

  await fs.mkdir(ZETA_DATA_DIR, { recursive: true })

  // Allocate port: honour ZENGRAM_PORT if set, otherwise auto-pick.
  const port = parseInt(process.env.ZENGRAM_PORT ?? "0") || (await findFreePort())

  // Download model files in the background — embed() falls back gracefully
  // to keyword search until the files arrive.
  ensureModelFiles().catch((e) =>
    log.warn("embedding model download failed — keyword search will be used", { err: e }),
  )

  await spawnZeta(bin, ZETA_DATA_DIR, port)
  _port = port
  return port
}

/** Return the port of the currently running managed Zeta instance, or null. */
export function getZetaPort(): number | null {
  return _port
}

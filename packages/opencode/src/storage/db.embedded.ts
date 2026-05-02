/**
 * Embedded Zeta storage driver for OpenCode.
 *
 * Opens an in-process Zeta database via the zeta-db NAPI binding — no
 * subprocess, no network port, no pgwire. Uses the synchronous ZetaDbSync
 * C FFI (via napi-rs), wrapped in Promises to satisfy the Queryable interface.
 *
 * Call initEmbedded(dataDir) once at startup. All callers then use
 * zengramDb() from db.zengram.ts transparently.
 *
 * Storage modes:
 *   "lsm"   — LSM-tree, better write throughput (default; matches old subprocess args)
 *   "btree" — B+tree, balanced read/write
 *
 * For integration tests or snapshot isolation, pass ":memory:" as dataDir.
 */

import * as zetaDb from "zeta-db"
import type { Database } from "zeta-db"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { type Queryable, setZengramClient } from "./db.zengram"
import { Log } from "@/util/log"

const log = Log.create({ service: "zeta-embedded" })

// ── EmbeddedClient ────────────────────────────────────────────────────────────

class EmbeddedClient implements Queryable {
  constructor(private db: Database) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.query(sql, params as any) as T[]
  }

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    const result = this.db.execute(sql, params as any)
    return typeof result === "number" ? result : 0
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _db: Database | null = null

/**
 * Open the embedded Zeta database and register it as the active Zengram client.
 *
 * Must be called before any storage operations. Safe to call multiple times —
 * subsequent calls are no-ops.
 *
 * @param dataDir  Directory where Zeta stores data files, or ":memory:" for
 *                 a transient in-process database (tests / CI).
 * @param mode     Storage engine — "lsm" (default) or "btree".
 */
export function initEmbedded(dataDir: string, mode: "lsm" | "btree" = "lsm"): void {
  if (_db) return

  log.info("opening embedded zeta", { dataDir, mode })
  const db = dataDir === ":memory:" ? zetaDb.open(":memory:") : zetaDb.open(dataDir, mode)
  if (!db) throw new Error(`zetaDb.open failed for ${dataDir}`)
  registerLocalEmbed(db)
  _db = db
  setZengramClient(new EmbeddedClient(db))
  log.info("embedded zeta ready")
}

function registerLocalEmbed(db: Database): void {
  if (typeof db.useLocalEmbed !== "function") {
    log.info("embed(): useLocalEmbed not present — binding built without local-embed feature")
    return
  }
  const explicit = process.env["OPENCODE_EMBED_MODEL_DIR"]
  const candidate = explicit ?? path.join(homedir(), "embed")
  if (!existsSync(path.join(candidate, "model.onnx")) || !existsSync(path.join(candidate, "vocab.txt"))) {
    if (explicit) log.warn("OPENCODE_EMBED_MODEL_DIR missing model.onnx/vocab.txt", { dir: candidate })
    else log.info("embed(): no model dir found, skipping local-embed registration", { tried: candidate })
    return
  }
  try {
    const dims = db.useLocalEmbed(candidate)
    log.info("embed() provider registered (local ONNX)", { dir: candidate, dims })
  } catch (err) {
    log.warn("embed() local provider registration failed — keyword fallback active", {
      dir: candidate,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Return the raw NAPI Database handle.
 *
 * Used by the embedded migration runner (runEmbeddedMigrations) which needs
 * runScript() for multi-statement DDL. Not needed by regular application code.
 */
export function rawEmbeddedDb(): Database {
  if (!_db) throw new Error("Embedded Zeta not initialized. Call initEmbedded() first.")
  return _db
}

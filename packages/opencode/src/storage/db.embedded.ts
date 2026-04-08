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
import { type Queryable, setZengramClient } from "./db.zengram"
import { Log } from "@/util/log"

const log = Log.create({ service: "zeta-embedded" })

// ── EmbeddedClient ────────────────────────────────────────────────────────────

class EmbeddedClient implements Queryable {
  constructor(private db: Database) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
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
export function initEmbedded(dataDir: string, mode: zetaDb.StorageMode = "lsm"): void {
  if (_db) return

  log.info("opening embedded zeta", { dataDir, mode })
  _db = dataDir === ":memory:" ? zetaDb.open(":memory:") : zetaDb.open(dataDir, mode)
  setZengramClient(new EmbeddedClient(_db))
  log.info("embedded zeta ready")
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

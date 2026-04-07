/**
 * Zengram storage backend for OpenCode.
 *
 * Two modes:
 *  - Embedded (default): in-process Zeta via NAPI — no subprocess, no pgwire.
 *    Initialised by db.embedded.ts which calls setZengramClient().
 *  - pgwire (OPENCODE_STORAGE=pgwire): connects to an external Zeta server.
 *
 * All callers use zengramDb() regardless of which mode is active.
 */

import pg from "pg"

export interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<number>
}

// ── pgwire client (used in server/remote mode) ────────────────────────────────

class ZengramClient implements Queryable {
  constructor(private pool: pg.Pool) {}

  static async connect(opts: {
    host?: string
    port?: number
    database?: string
    user?: string
    password?: string | undefined
    max?: number
  }): Promise<ZengramClient> {
    const pool = new pg.Pool({
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 5433,
      user: opts.user ?? "zeta",
      password: opts.password,
      database: opts.database,
      max: opts.max ?? 10,
    })
    const client = await pool.connect()
    client.release()
    return new ZengramClient(pool)
  }

  async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params)
    return result.rows as T[]
  }

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.pool.query(sql, params)
    return result.rowCount ?? 0
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  getPool(): pg.Pool {
    return this.pool
  }
}

// ── Active client (set by initZengram or db.embedded.ts) ──────────────────────

let _client: Queryable | null = null
let _pgClient: ZengramClient | null = null

/**
 * Inject a client — called by db.embedded.ts after opening the NAPI database.
 * Not intended for direct use by application code.
 */
export function setZengramClient(client: Queryable): void {
  _client = client
}

/** Initialise the pgwire Zengram connection (external server mode). */
export async function initZengram(): Promise<void> {
  if (_client) return

  const host = process.env.ZENGRAM_HOST ?? "127.0.0.1"
  const port = parseInt(process.env.ZENGRAM_PORT ?? "5433")
  const database = process.env.ZENGRAM_DATABASE ?? "zengram"
  const user = process.env.ZENGRAM_USER ?? "zengram"
  const password = process.env.ZENGRAM_PASSWORD

  // Ensure the target database exists. Zeta always has "zeta" as default;
  // a named database must be created before it can be used for queries.
  if (database !== "zeta") {
    const bootstrap = await ZengramClient.connect({ host, port, database: "zeta", user, password, max: 1 })
    await bootstrap.execute(`CREATE DATABASE IF NOT EXISTS ${database}`, []).catch(() => {
      return bootstrap.execute(`CREATE DATABASE ${database}`, []).catch(() => {/* already exists */})
    })
    await bootstrap.close()
  }

  _pgClient = await ZengramClient.connect({ host, port, database, user, password, max: 10 })
  _client = _pgClient
}

/** Return the active Zengram client. Throws if not initialised. */
export function zengramDb(): Queryable {
  if (!_client) {
    throw new Error(
      "Zengram client not initialised. " +
        "Ensure initEmbedded() or initZengram() is called before the first storage operation.",
    )
  }
  return _client
}

/** Return the raw pg.Pool (pgwire mode only — throws in embedded mode). */
export function zengramPool(): pg.Pool {
  if (!_pgClient) {
    throw new Error(
      "zengramPool() called but pgwire mode is not active. " +
        "Use the embedded migration runner instead.",
    )
  }
  return _pgClient.getPool()
}

/**
 * Zengram is enabled whenever the storage backend is not plain SQLite.
 * Embedded mode is the default; pgwire is opt-in via OPENCODE_STORAGE=pgwire.
 */
export const ZENGRAM_ENABLED = process.env.OPENCODE_STORAGE !== "sqlite"

/** True when running in pgwire (external server) mode. */
export const PGWIRE_MODE = process.env.OPENCODE_STORAGE === "pgwire"

/** Close the active connection (pgwire only; embedded is closed via GC). */
export async function closeZengram(): Promise<void> {
  if (_pgClient) {
    await _pgClient.close()
    _pgClient = null
    _client = null
  }
}

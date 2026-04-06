/**
 * Zengram storage backend for OpenCode.
 *
 * Activated when OPENCODE_STORAGE=zengram is set.
 * Connects to a Zeta server via pgwire (default: localhost:5433).
 *
 * Inlines the pg-based client so we don't depend on the @zengram/sdk build.
 */

import pg from "pg"

export interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<number>
}

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
}

let _client: ZengramClient | null = null

/** Initialise the Zengram connection. Call once at application startup. */
export async function initZengram(): Promise<void> {
  if (_client) return

  const host = process.env.ZENGRAM_HOST ?? "127.0.0.1"
  const port = parseInt(process.env.ZENGRAM_PORT ?? "5433")
  const database = process.env.ZENGRAM_DATABASE ?? "zengram"
  const user = process.env.ZENGRAM_USER ?? "zengram"
  const password = process.env.ZENGRAM_PASSWORD

  // Ensure the target database exists. Zeta always has "zeta" as default;
  // a named database must be created before it can be used for queries.
  // We connect to "zeta" briefly to CREATE DATABASE if it doesn't exist yet.
  if (database !== "zeta") {
    const bootstrap = await ZengramClient.connect({ host, port, database: "zeta", user, password, max: 1 })
    await bootstrap.execute(`CREATE DATABASE IF NOT EXISTS ${database}`, []).catch(() => {
      // IF NOT EXISTS may not be supported; try without the guard.
      return bootstrap.execute(`CREATE DATABASE ${database}`, []).catch(() => {/* already exists */})
    })
    await bootstrap.close()
  }

  _client = await ZengramClient.connect({ host, port, database, user, password, max: 10 })
}

/** Return the active Zengram client. Throws if not initialised. */
export function zengramDb(): Queryable {
  if (!_client) {
    throw new Error(
      "Zengram client not initialised. " +
        "Ensure initZengram() is called before the first storage operation.",
    )
  }
  return _client
}

/** Return the raw pg.Pool for operations that need transaction control (e.g. migrations). */
export function zengramPool(): pg.Pool {
  if (!_client) {
    throw new Error("Zengram client not initialised.")
  }
  return (_client as ZengramClient)["pool"] as pg.Pool
}

/** Whether Zengram storage is enabled for this process. */
export const ZENGRAM_ENABLED = process.env.OPENCODE_STORAGE === "zengram"

/** Close the Zengram connection pool (call at shutdown). */
export async function closeZengram(): Promise<void> {
  if (_client) {
    await _client.close()
    _client = null
  }
}

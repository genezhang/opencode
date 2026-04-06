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
  _client = await ZengramClient.connect({
    host: process.env.ZENGRAM_HOST ?? "127.0.0.1",
    port: parseInt(process.env.ZENGRAM_PORT ?? "5433"),
    database: process.env.ZENGRAM_DATABASE ?? "zengram",
    user: process.env.ZENGRAM_USER ?? "zengram",
    password: process.env.ZENGRAM_PASSWORD,
    max: 10,
  })
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

/** Whether Zengram storage is enabled for this process. */
export const ZENGRAM_ENABLED = process.env.OPENCODE_STORAGE === "zengram"

/** Close the Zengram connection pool (call at shutdown). */
export async function closeZengram(): Promise<void> {
  if (_client) {
    await _client.close()
    _client = null
  }
}

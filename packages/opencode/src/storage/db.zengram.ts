/**
 * Zengram storage backend for OpenCode.
 *
 * Activated when OPENCODE_STORAGE=zengram is set.
 * Connects to a Zeta server via pgwire (default: localhost:5433).
 */

import { ZengramClient, type Queryable } from "@zengram/sdk"

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

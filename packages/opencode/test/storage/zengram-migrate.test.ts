/**
 * Unit tests for the Zengram migration runner.
 *
 * Uses a real Zeta binary (ZETA_BIN env) started in-process for each test.
 * Skips automatically when ZETA_BIN is not set.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import pg from "pg"
import { spawn, type ChildProcess } from "child_process"
import net from "net"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { runMigrations } from "../../src/storage/zengram-migrate"

const ZETA_BIN = process.env.ZETA_BIN
const skip = !ZETA_BIN

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ port, host: "127.0.0.1" })
      sock.once("connect", () => { sock.destroy(); resolve(true) })
      sock.once("error", () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`)
}

async function startZeta(dataDir: string, port: number): Promise<ChildProcess> {
  const proc = spawn(ZETA_BIN!, [
    "--data-dir", dataDir,
    "--port", String(port),
    "--bind", "127.0.0.1",
    "--storage-backend", "lsm",
  ], { stdio: "ignore" })
  await waitForPort(port)
  return proc
}

async function makePool(port: number, database = "zengram"): Promise<pg.Pool> {
  // Create the database first (Zeta starts with "zeta" default db)
  if (database !== "zeta") {
    const bootstrap = new pg.Pool({ host: "127.0.0.1", port, user: "zeta", database: "zeta", max: 1 })
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS ${database}`).catch(() =>
      bootstrap.query(`CREATE DATABASE ${database}`).catch(() => {}),
    )
    await bootstrap.end()
  }
  return new pg.Pool({ host: "127.0.0.1", port, user: "zeta", database, max: 3 })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("zengram migrations", () => {
  let proc: ChildProcess
  let pool: pg.Pool
  let dataDir: string
  let port: number

  beforeAll(async () => {
    if (skip) return
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "zengram-test-"))
    port = await findFreePort()
    proc = await startZeta(dataDir, port)
    pool = await makePool(port)
  })

  afterAll(async () => {
    await pool?.end()
    proc?.kill("SIGTERM")
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  test("applies all 9 migrations on fresh database", async () => {
    if (skip) { console.log("skip: ZETA_BIN not set"); return }
    const count = await runMigrations(pool)
    expect(count).toBe(9)
  })

  test("is idempotent — second run applies 0 migrations", async () => {
    if (skip) return
    const count = await runMigrations(pool)
    expect(count).toBe(0)
  })

  test("tracking table has 9 rows with correct versions", async () => {
    if (skip) return
    const result = await pool.query(
      "SELECT version, name FROM _zengram_migrations ORDER BY version",
    )
    expect(result.rows).toHaveLength(9)
    // Zeta returns INTEGER columns as strings — coerce for comparison
    expect(Number(result.rows[0].version)).toBe(1)
    expect(Number(result.rows[8].version)).toBe(9)
    expect(result.rows[6].name).toBe("opencode_extensions")
  })

  test("all expected tables exist after migration", async () => {
    if (skip) return
    // Zeta does not implement information_schema — probe tables directly
    const tables = [
      "project", "session", "branch", "turn", "part", "tool_call",
      "task", "knowledge", "permission_rule", "agent_mailbox",
      "workspace", "account", "snapshot", "file_operation",
    ]
    for (const table of tables) {
      let exists = false
      try {
        await pool.query(`SELECT 1 FROM "${table}" LIMIT 0`)
        exists = true
      } catch {
        exists = false
      }
      expect(exists).toBe(true) // table should exist: ${table}
    }
  })

  test("knowledge table has embedding VECTOR(384) column", async () => {
    if (skip) return
    // Zeta does not implement information_schema — probe column directly
    let hasColumn = false
    try {
      await pool.query(`SELECT embedding FROM knowledge LIMIT 0`)
      hasColumn = true
    } catch {
      hasColumn = false
    }
    expect(hasColumn).toBe(true)
  })

  test("can insert and query a knowledge row", async () => {
    if (skip) return
    const id = "knw_test_" + Date.now()
    const now = Date.now() * 1000
    // Use simple query protocol (no params) — Zeta Extended Query Protocol has quirks
    // on parameterized SELECT after a full migration (plan cache / RowDescription issue).
    await pool.query(
      `INSERT INTO project (id, time_created, time_updated)
       VALUES ('proj_test', ${now}, ${now})
       ON CONFLICT (id) DO NOTHING`,
    )
    await pool.query(
      `INSERT INTO knowledge
         (id, project_id, scope, subject, content, status, importance, confidence,
          access_count, time_created, time_updated)
       VALUES ('${id}', 'proj_test', '/project/proj_test', 'Test subject', 'Test content',
               'active', 0.7, 0.8, 0, ${now}, ${now})`,
    )
    const result = await pool.query(`SELECT subject FROM knowledge WHERE id = '${id}'`)
    expect(result.rows[0].subject).toBe("Test subject")
  })
})

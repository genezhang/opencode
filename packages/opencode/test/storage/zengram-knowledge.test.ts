/**
 * Integration tests for knowledge store functions.
 *
 * Requires ZETA_BIN to be set. Skips automatically otherwise.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test"
import pg from "pg"
import { spawn, type ChildProcess } from "child_process"
import net from "net"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { runMigrations } from "../../src/storage/zengram-migrate"

const ZETA_BIN = process.env.ZETA_BIN
const skip = !ZETA_BIN

// ── Helpers (shared with migration test) ─────────────────────────────────────

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

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ port, host: "127.0.0.1" })
      sock.once("connect", () => { sock.destroy(); resolve(true) })
      sock.once("error", () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("Zeta not ready")
}

// ── Queryable shim ────────────────────────────────────────────────────────────

// knowledge/index.ts imports zengramDb() which reads a module-level singleton.
// We mock db.zengram so the knowledge functions use our test pool instead.

/**
 * Inline $1/$2/... params into the SQL string so every query uses
 * Simple Query Protocol — avoids Zeta Extended Query Protocol quirks
 * (plan-cache issues, missing RowDescription on some prepared statements).
 */
function injectParams(sql: string, params: unknown[]): string {
  let i = 0
  return sql.replace(/\$\d+/g, () => {
    const val = params[i++]
    if (val === null || val === undefined) return "NULL"
    if (typeof val === "number") return String(val)
    if (typeof val === "boolean") return val ? "TRUE" : "FALSE"
    return "'" + String(val).replace(/'/g, "''") + "'"
  })
}

function makeQueryable(pool: pg.Pool) {
  return {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const resolved = params.length > 0 ? injectParams(sql, params) : sql
      const result = await pool.query(resolved)
      return result.rows as T[]
    },
    async execute(sql: string, params: unknown[] = []) {
      const resolved = params.length > 0 ? injectParams(sql, params) : sql
      const result = await pool.query(resolved)
      return result.rowCount ?? 0
    },
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("knowledge store", () => {
  let proc: ChildProcess
  let pool: pg.Pool
  let dataDir: string
  let queryable: ReturnType<typeof makeQueryable>
  const projectId = "proj_ktest" as any
  const sessionId = "sess_ktest" as any
  const turnId = "turn_ktest" as any

  beforeAll(async () => {
    if (skip) return

    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "zengram-ktest-"))
    const port = await findFreePort()
    proc = spawn(ZETA_BIN!, [
      "--data-dir", dataDir, "--port", String(port),
      "--bind", "127.0.0.1", "--storage-backend", "lsm",
    ], { stdio: "ignore" })
    await waitForPort(port)

    // Bootstrap database
    const bootstrap = new pg.Pool({ host: "127.0.0.1", port, user: "zeta", database: "zeta", max: 1 })
    await bootstrap.query("CREATE DATABASE IF NOT EXISTS zengram").catch(() =>
      bootstrap.query("CREATE DATABASE zengram").catch(() => {}),
    )
    await bootstrap.end()

    pool = new pg.Pool({ host: "127.0.0.1", port, user: "zeta", database: "zengram", max: 3 })
    await runMigrations(pool)
    queryable = makeQueryable(pool)

    // Seed rows required by knowledge FK constraints.
    // Use simple query protocol (no params) — more robust with Zeta.
    const now = Date.now() * 1000
    await pool.query(`INSERT INTO project (id, time_created, time_updated) VALUES ('${projectId}', ${now}, ${now}) ON CONFLICT DO NOTHING`)
    await pool.query(`INSERT INTO session (id, project_id, slug, status, time_created, time_updated) VALUES ('${sessionId}', '${projectId}', 'test', 'active', ${now}, ${now}) ON CONFLICT DO NOTHING`)
    const branchId = "branch_ktest"
    await pool.query(`INSERT INTO branch (id, session_id, time_created, time_updated) VALUES ('${branchId}', '${sessionId}', ${now}, ${now}) ON CONFLICT DO NOTHING`)
    await pool.query(`INSERT INTO turn (id, session_id, branch_id, role, time_created) VALUES ('${turnId}', '${sessionId}', '${branchId}', 'user', ${now}) ON CONFLICT DO NOTHING`)

    // Mock zengramDb() — use same alias as knowledge/index.ts imports
    mock.module("@/storage/db.zengram", () => ({
      ZENGRAM_ENABLED: true,
      zengramDb: () => queryable,
      zengramPool: () => pool,
      initZengram: async () => {},
      closeZengram: async () => {},
    }))
  })

  afterAll(async () => {
    await pool?.end()
    proc?.kill("SIGTERM")
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  test("learnFact stores a new fact", async () => {
    if (skip) { console.log("skip: ZETA_BIN not set"); return }
    const { learnFact } = await import("../../src/knowledge/index")
    const { id, isNew } = await learnFact({
      projectId,
      scope: "/project",
      subject: "Use parameterized queries",
      content: "Always use $1 placeholders, never interpolate SQL strings.",
      sourceSession: sessionId,
      sourceTurn: turnId,
    })
    expect(isNew).toBe(true)
    expect(id).toMatch(/^knw_/)
  })

  test("learnFact deduplicates same subject + scope", async () => {
    if (skip) return
    const { learnFact } = await import("../../src/knowledge/index")
    const { isNew } = await learnFact({
      projectId,
      scope: "/project",
      subject: "Use parameterized queries",
      content: "Duplicate.",
      sourceSession: sessionId,
      sourceTurn: turnId,
    })
    expect(isNew).toBe(false)
  })

  test("recallFacts returns stored facts", async () => {
    if (skip) return
    const { recallFacts } = await import("../../src/knowledge/index")
    const facts = await recallFacts({ projectId, limit: 10 })
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.some((f) => f.subject === "Use parameterized queries")).toBe(true)
  })

  test("searchFacts finds by keyword (embed fallback)", async () => {
    if (skip) return
    const { searchFacts } = await import("../../src/knowledge/index")
    const facts = await searchFacts({ projectId, query: "parameterized" })
    expect(facts.some((f) => f.subject.includes("parameterized"))).toBe(true)
  })

  test("forgetFact marks entry inactive", async () => {
    if (skip) return
    const { learnFact, forgetFact, recallFacts } = await import("../../src/knowledge/index")
    const { id } = await learnFact({
      projectId,
      scope: "/project",
      subject: "Temporary fact to forget",
      content: "This should be removed.",
      sourceSession: sessionId,
      sourceTurn: turnId,
    })
    const forgotten = await forgetFact({ id })
    expect(forgotten).toBe(true)

    const facts = await recallFacts({ projectId, limit: 50 })
    expect(facts.some((f) => f.id === id)).toBe(false)
  })

  test("extractFacts finds normative sentences", async () => {
    if (skip) return
    const { extractFacts } = await import("../../src/knowledge/index")
    const text = `
      Always use parameterized queries to prevent SQL injection.
      The database connection should be reused across requests.
      Never store plaintext passwords in the database.
    `
    const facts = extractFacts(text)
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.some((f) => f.content.toLowerCase().includes("parameterized"))).toBe(true)
  })

  test("decayKnowledge runs without error", async () => {
    if (skip) return
    const { decayKnowledge } = await import("../../src/knowledge/index")
    // Should run (or skip if already ran today) without throwing
    await expect(decayKnowledge({ projectId, halfLifeDays: 30 })).resolves.toBeTypeOf("number")
  })
})

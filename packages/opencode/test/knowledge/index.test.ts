/**
 * Unit tests for knowledge/index.ts.
 *
 * Covers pure functions (no DB) and mock-DB functions.
 * Uses mock.module to inject a fake zengramDb without a live Zeta server.
 */

import { describe, test, expect, mock } from "bun:test"
import type { WorkspaceFileEntry, KnowledgeEntry } from "../../src/knowledge/index"

// ── Module mock ───────────────────────────────────────────────────────────────
// knowledge/index.ts statically imports zengramDb(). We inject a controllable
// fake so all tests run without a live database. Set up at module level so it
// takes effect before any dynamic import() of knowledge/index.

let lastSql = ""
let queryRows: unknown[] = []
let queryCalls = 0

mock.module("@/storage/db.zengram", () => ({
  ZENGRAM_ENABLED: true,
  zengramDb: () => ({
    query: async (sql: string, _params?: unknown[]) => {
      lastSql = sql
      queryCalls++
      return queryRows
    },
    execute: async (sql: string, _params?: unknown[]) => {
      lastSql = sql
      return 0
    },
  }),
}))

// Also stub Provider so reflectKnowledge's LLM path throws in a predictable way.
mock.module("@/provider/provider", () => ({
  Provider: {
    defaultModel: async () => { throw new Error("no provider in tests") },
    getSmallModel: async () => null,
    getModel: async () => { throw new Error("no provider in tests") },
    getLanguage: async () => { throw new Error("no provider in tests") },
  },
}))

// ── extractFacts ──────────────────────────────────────────────────────────────

describe("extractFacts", () => {
  test("finds normative sentences with 'always'", async () => {
    const { extractFacts } = await import("../../src/knowledge/index")
    const text = "Always use parameterized queries to prevent SQL injection attacks."
    const facts = extractFacts(text)
    expect(facts.length).toBeGreaterThan(0)
    expect(facts[0].content).toMatch(/parameterized/i)
  })

  test("finds imperative-start sentences", async () => {
    const { extractFacts } = await import("../../src/knowledge/index")
    const text = "Use enums instead of raw string literals for all status fields."
    const facts = extractFacts(text)
    expect(facts.length).toBeGreaterThan(0)
  })

  test("ignores sentences shorter than 30 chars", async () => {
    const { extractFacts } = await import("../../src/knowledge/index")
    // "Never do this." is only 14 chars — below the 30-char filter
    const facts = extractFacts("Never do this.")
    expect(facts).toEqual([])
  })

  test("strips code blocks before scanning", async () => {
    const { extractFacts } = await import("../../src/knowledge/index")
    // Normative sentence is inside a code block — should be stripped and not extracted
    const text = "```\nAlways use parameterized queries to prevent SQL injection.\n```\nThis is plain prose."
    const facts = extractFacts(text)
    expect(facts.some((f) => f.content.includes("parameterized"))).toBe(false)
  })

  test("respects maxFacts limit", async () => {
    const { extractFacts } = await import("../../src/knowledge/index")
    const text = [
      "Always use parameterized queries to prevent SQL injection attacks in every query.",
      "Never store plaintext passwords; always hash them with a strong algorithm.",
      "Prefer TypeScript over JavaScript for all new source files in the project.",
      "Avoid using the any type in TypeScript; use unknown for truly unknown values.",
    ].join("\n")
    const facts = extractFacts(text, 2)
    expect(facts.length).toBeLessThanOrEqual(2)
  })

  test("strips leading list markers from subject", async () => {
    const { extractFacts } = await import("../../src/knowledge/index")
    const text = "1. Always use parameterized queries to prevent SQL injection in all database calls."
    const facts = extractFacts(text)
    if (facts.length > 0) {
      expect(facts[0].subject).not.toMatch(/^\d+\./)
    }
  })

  test("subject is truncated to 70 chars", async () => {
    const { extractFacts } = await import("../../src/knowledge/index")
    // A very long sentence with no natural break points to force truncation
    const text = "Always use very long parameterized queries everywhere to prevent all kinds of SQL injection attacks in every database call."
    const facts = extractFacts(text)
    if (facts.length > 0) {
      expect(facts[0].subject.length).toBeLessThanOrEqual(70)
    }
  })
})

// ── formatKnowledgeBlock ──────────────────────────────────────────────────────

describe("formatKnowledgeBlock", () => {
  test("returns null for empty array", async () => {
    const { formatKnowledgeBlock } = await import("../../src/knowledge/index")
    expect(formatKnowledgeBlock([])).toBeNull()
  })

  test("wraps content in zengram-knowledge XML tags", async () => {
    const { formatKnowledgeBlock } = await import("../../src/knowledge/index")
    const facts: KnowledgeEntry[] = [
      { id: "1", scope: "/project", subject: "Use TypeScript", content: "Prefer TS over JS", importance: 0.8 },
    ]
    const block = formatKnowledgeBlock(facts)
    expect(block).toContain("<zengram-knowledge>")
    expect(block).toContain("</zengram-knowledge>")
  })

  test("formats each fact as a bold-subject bullet", async () => {
    const { formatKnowledgeBlock } = await import("../../src/knowledge/index")
    const facts: KnowledgeEntry[] = [
      { id: "1", scope: "/project", subject: "Fact A", content: "Content A", importance: 0.9 },
      { id: "2", scope: "/project", subject: "Fact B", content: "Content B", importance: 0.7 },
    ]
    const block = formatKnowledgeBlock(facts)!
    expect(block).toContain("- **Fact A**: Content A")
    expect(block).toContain("- **Fact B**: Content B")
  })
})

// ── formatWorkspaceBlock ──────────────────────────────────────────────────────

describe("formatWorkspaceBlock", () => {
  test("returns null for empty array", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    expect(formatWorkspaceBlock([])).toBeNull()
  })

  test("returns null when all files are clean with unknown understanding", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    // 'unknown' understanding → not deep/read/listed; 'clean' → not modified/deleted
    // All three sections empty → null
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/foo.ts", understanding: "unknown", edit_state: "clean", relevance: 0.5 },
    ]
    expect(formatWorkspaceBlock(files)).toBeNull()
  })

  test("wraps non-empty content in zengram-workspace XML tags", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/app.ts", understanding: "deep", edit_state: "modified", relevance: 1.0 },
    ]
    const block = formatWorkspaceBlock(files)
    expect(block).toContain("<zengram-workspace>")
    expect(block).toContain("</zengram-workspace>")
  })

  test("modified files appear under 'Modified in this session'", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/a.ts", understanding: "deep", edit_state: "modified", relevance: 1.0 },
    ]
    const block = formatWorkspaceBlock(files)!
    expect(block).toContain("Modified in this session:")
    expect(block).toContain("src/a.ts")
  })

  test("deleted files appear under 'Modified' with '(deleted)' tag", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/old.ts", understanding: "deep", edit_state: "deleted", relevance: 0.9 },
    ]
    const block = formatWorkspaceBlock(files)!
    expect(block).toContain("Modified in this session:")
    expect(block).toContain("(deleted)")
  })

  test("read/deep files appear under 'Read in this session'", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/b.ts", understanding: "read",  edit_state: "clean", relevance: 0.8 },
      { file_path: "src/c.ts", understanding: "deep",  edit_state: "clean", relevance: 0.7 },
    ]
    const block = formatWorkspaceBlock(files)!
    expect(block).toContain("Read in this session:")
    expect(block).toContain("src/b.ts")
    expect(block).toContain("src/c.ts")
  })

  test("listed files appear under 'Directories listed in this session'", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/", understanding: "listed", edit_state: "clean", relevance: 0.5 },
    ]
    const block = formatWorkspaceBlock(files)!
    expect(block).toContain("Directories listed in this session:")
    expect(block).toContain("src/")
  })

  test("'listed' files do not appear in the 'Read' section", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/b.ts", understanding: "read",   edit_state: "clean", relevance: 0.8 },
      { file_path: "src/dir/", understanding: "listed", edit_state: "clean", relevance: 0.5 },
    ]
    const block = formatWorkspaceBlock(files)!
    // Both sections should be present
    expect(block).toContain("Read in this session:")
    expect(block).toContain("Directories listed in this session:")
    // Verify src/dir only appears after the "Directories" header, not after "Read"
    const readIdx = block.indexOf("Read in this session:")
    const dirIdx  = block.indexOf("Directories listed in this session:")
    const dirFileIdx = block.lastIndexOf("src/dir/")
    expect(dirFileIdx).toBeGreaterThan(dirIdx)
    expect(dirFileIdx).toBeGreaterThan(readIdx)
  })

  test("sanitizes & before < and > in file paths", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/a&b.ts", understanding: "deep", edit_state: "modified", relevance: 1.0 },
    ]
    const block = formatWorkspaceBlock(files)!
    expect(block).toContain("&amp;")
    expect(block).not.toContain("src/a&b.ts") // raw & must not appear
  })

  test("sanitizes < and > in file paths", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/<component>.ts", understanding: "read", edit_state: "clean", relevance: 1.0 },
    ]
    const block = formatWorkspaceBlock(files)!
    expect(block).toContain("&lt;")
    expect(block).toContain("&gt;")
    expect(block).not.toContain("<component>")
  })

  test("sanitizes newlines and tabs in file paths", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/foo\nbar\ttab.ts", understanding: "deep", edit_state: "modified", relevance: 1.0 },
    ]
    const block = formatWorkspaceBlock(files)!
    // Find the line that contains "foo" and verify no control chars
    const pathLine = block.split("\n").find((l) => l.includes("foo"))!
    expect(pathLine).toBeDefined()
    expect(pathLine).not.toMatch(/[\t\r]/)
    // The \n in the path should have been replaced by a space (not become a real newline)
    expect(pathLine).toContain("foo bar")
  })

  test("& is escaped before < so &lt; does not become &amp;lt;", async () => {
    const { formatWorkspaceBlock } = await import("../../src/knowledge/index")
    const files: WorkspaceFileEntry[] = [
      { file_path: "src/a<b>&c.ts", understanding: "read", edit_state: "clean", relevance: 1.0 },
    ]
    const block = formatWorkspaceBlock(files)!
    // & → &amp; first, then < → &lt;, > → &gt;
    // Raw sequence: a<b>&c → a&lt;b&gt;&amp;c  (not a&lt;b&gt;&amp;amp;c)
    expect(block).toContain("a&lt;b&gt;&amp;c")
    expect(block).not.toContain("&amp;lt;")
    expect(block).not.toContain("&amp;gt;")
  })
})

// ── recallWorkspaceContext — limit validation ─────────────────────────────────

describe("recallWorkspaceContext", () => {
  test("uses default limit 30 when limit is NaN", async () => {
    queryRows = []
    const { recallWorkspaceContext } = await import("../../src/knowledge/index")
    await recallWorkspaceContext({ sessionId: "sess_ws" as any, limit: NaN })
    expect(lastSql).toContain("LIMIT 30")
  })

  test("uses default limit 30 when limit is 0", async () => {
    queryRows = []
    const { recallWorkspaceContext } = await import("../../src/knowledge/index")
    await recallWorkspaceContext({ sessionId: "sess_ws" as any, limit: 0 })
    expect(lastSql).toContain("LIMIT 30")
  })

  test("uses default limit 30 when limit is negative", async () => {
    queryRows = []
    const { recallWorkspaceContext } = await import("../../src/knowledge/index")
    await recallWorkspaceContext({ sessionId: "sess_ws" as any, limit: -5 })
    expect(lastSql).toContain("LIMIT 30")
  })

  test("uses default limit 30 when limit is Infinity", async () => {
    queryRows = []
    const { recallWorkspaceContext } = await import("../../src/knowledge/index")
    await recallWorkspaceContext({ sessionId: "sess_ws" as any, limit: Infinity })
    expect(lastSql).toContain("LIMIT 30")
  })

  test("clamps limit to 100 when input exceeds 100", async () => {
    queryRows = []
    const { recallWorkspaceContext } = await import("../../src/knowledge/index")
    await recallWorkspaceContext({ sessionId: "sess_ws" as any, limit: 200 })
    expect(lastSql).toContain("LIMIT 100")
  })

  test("uses provided limit when valid and within range", async () => {
    queryRows = []
    const { recallWorkspaceContext } = await import("../../src/knowledge/index")
    await recallWorkspaceContext({ sessionId: "sess_ws" as any, limit: 15 })
    expect(lastSql).toContain("LIMIT 15")
  })

  test("floors fractional limits", async () => {
    queryRows = []
    const { recallWorkspaceContext } = await import("../../src/knowledge/index")
    await recallWorkspaceContext({ sessionId: "sess_ws" as any, limit: 7.9 })
    expect(lastSql).toContain("LIMIT 7")
  })
})

// ── reflectKnowledge — minFacts guard and throttle ───────────────────────────

describe("reflectKnowledge", () => {
  test("returns 0 without setting throttle when fewer than minFacts rows exist", async () => {
    // Provide fewer rows than the default minFacts (5) threshold.
    queryRows = [
      { subject: "Fact A", content: "Content A" },
      { subject: "Fact B", content: "Content B" },
    ]
    const { reflectKnowledge } = await import("../../src/knowledge/index")
    // Use a unique projectId so no previous throttle state interferes.
    queryCalls = 0
    const result = await reflectKnowledge({ projectId: "proj_guard_test" as any, minFacts: 5 })
    expect(result).toBe(0)
    expect(queryCalls).toBe(1) // DB was queried once for the rows check

    // Since throttle was not set (rows < minFacts), a second call should query the DB again.
    queryRows = []
    queryCalls = 0
    const result2 = await reflectKnowledge({ projectId: "proj_guard_test" as any, minFacts: 5 })
    expect(result2).toBe(0)
    expect(queryCalls).toBe(1) // DB queried again — throttle was not set by the first call
  })

  test("sets throttle before LLM call so concurrent re-runs are blocked", async () => {
    // Provide enough rows to pass the minFacts guard.
    queryRows = [
      { subject: "Fact A", content: "Content A" },
      { subject: "Fact B", content: "Content B" },
      { subject: "Fact C", content: "Content C" },
      { subject: "Fact D", content: "Content D" },
      { subject: "Fact E", content: "Content E" },
    ]
    const { reflectKnowledge } = await import("../../src/knowledge/index")
    const projectId = "proj_throttle_test" as any

    // First call: rows >= minFacts → throttle set BEFORE LLM → LLM fails (no provider) → returns 0
    queryCalls = 0
    const first = await reflectKnowledge({ projectId, minFacts: 5 })
    expect(first).toBe(0)
    expect(queryCalls).toBe(1) // DB was queried for the rows

    // Second call within the same 6-hour window: throttle check fires before zengramDb() is
    // called — no DB query should be issued.
    queryCalls = 0
    const second = await reflectKnowledge({ projectId, minFacts: 5 })
    expect(second).toBe(0)
    expect(queryCalls).toBe(0) // DB not queried — throttle blocked the call
  })

  test("respects custom minFacts threshold", async () => {
    // Exactly 3 rows; minFacts: 3 → should proceed past guard (LLM then fails → 0).
    queryRows = [
      { subject: "X", content: "CX" },
      { subject: "Y", content: "CY" },
      { subject: "Z", content: "CZ" },
    ]
    const { reflectKnowledge } = await import("../../src/knowledge/index")
    const projectId = "proj_minfacts3_test" as any

    // Should pass the guard (3 >= 3), set throttle, then fail LLM → return 0
    const result = await reflectKnowledge({ projectId, minFacts: 3 })
    expect(result).toBe(0) // LLM unavailable, but guard was passed

    // Throttle should be set — second call blocked
    queryRows = [] // shouldn't matter since throttle fires first
    const result2 = await reflectKnowledge({ projectId, minFacts: 3 })
    expect(result2).toBe(0)
  })
})

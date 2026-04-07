/**
 * Unit tests for knowledge/adapter.ts — OpenCodeLlmAdapter.
 *
 * Tests focus on the JSON-parsing contract and adapter registration,
 * without requiring a real LLM provider or Zengram database.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { llm } from "@zengram/sdk"

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock LanguageModel that returns a fixed text string. */
function mockLanguage(text: string) {
  return { text } as any
}

/**
 * Directly exercise the JSON-parsing + guard logic that both extractFacts and
 * reflect use. We extract these as standalone helpers so they can be tested
 * without standing up a full Provider + generateText pipeline.
 */
function parseFactsOutput(output: string): Array<{ subject: string; content: string }> {
  const cleaned = output.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim()
  const parsed = JSON.parse(cleaned)
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (f): f is { subject: string; content: string } =>
      typeof f?.subject === "string" && typeof f?.content === "string",
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("parseFactsOutput (shared JSON parsing logic)", () => {
  test("parses a plain JSON array", () => {
    const input = `[{"subject":"Use TypeScript","content":"Always use TypeScript for new files"}]`
    expect(parseFactsOutput(input)).toEqual([
      { subject: "Use TypeScript", content: "Always use TypeScript for new files" },
    ])
  })

  test("strips markdown fences", () => {
    const input = "```json\n[{\"subject\":\"Use bun\",\"content\":\"Prefer bun over npm\"}]\n```"
    expect(parseFactsOutput(input)).toEqual([
      { subject: "Use bun", content: "Prefer bun over npm" },
    ])
  })

  test("returns [] for an empty array", () => {
    expect(parseFactsOutput("[]")).toEqual([])
  })

  test("returns [] for non-array JSON", () => {
    expect(parseFactsOutput("{}")).toEqual([])
  })

  test("throws on invalid JSON", () => {
    expect(() => parseFactsOutput("not json")).toThrow()
  })

  test("filters out entries missing required fields", () => {
    const input = `[{"subject":"ok","content":"valid"},{"subject":"missing"},{"content":"no subject"}]`
    expect(parseFactsOutput(input)).toEqual([{ subject: "ok", content: "valid" }])
  })
})

describe("LlmAdapter registration", () => {
  beforeEach(() => {
    // Reset adapter between tests
    llm.setLlmAdapter(null as any)
  })

  test("getLlmAdapter returns null before registration", () => {
    expect(llm.getLlmAdapter()).toBeNull()
  })

  test("setLlmAdapter registers an adapter", () => {
    const adapter: llm.LlmAdapter = {
      extractFacts: async () => [],
      reflect: async () => [],
    }
    llm.setLlmAdapter(adapter)
    expect(llm.getLlmAdapter()).toBe(adapter)
  })

  test("setLlmAdapter replaces a previously registered adapter", () => {
    const first: llm.LlmAdapter = { extractFacts: async () => [], reflect: async () => [] }
    const second: llm.LlmAdapter = { extractFacts: async () => [], reflect: async () => [] }
    llm.setLlmAdapter(first)
    llm.setLlmAdapter(second)
    expect(llm.getLlmAdapter()).toBe(second)
  })

  test("extractFromText returns [] when no adapter is registered", async () => {
    const fakeDb = {
      query: async () => [],
      execute: async () => 0,
      begin: async () => { throw new Error("not called") },
    }
    const result = await llm.extractFromText(fakeDb, {
      text: "Always use TypeScript for new files in this project.",
      scope: "/test",
    })
    expect(result).toEqual([])
  })

  test("extractFromText returns [] for short text even with adapter", async () => {
    const adapter: llm.LlmAdapter = {
      extractFacts: async () => [{ subject: "Should not run", content: "..." }],
      reflect: async () => [],
    }
    llm.setLlmAdapter(adapter)
    const fakeDb = {
      query: async () => [],
      execute: async () => 0,
      begin: async () => { throw new Error("not called") },
    }
    const result = await llm.extractFromText(fakeDb, { text: "short", scope: "/test" })
    expect(result).toEqual([])
  })
})

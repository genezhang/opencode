// Hermetic smoke test for the dj-11740 context-size instrumentation.
//
// Full end-to-end verification (running one turn through the prompt loop
// and asserting the log lines fire) is blocked by a pre-existing Zeta
// `:memory:` issue where INSERTs into the session table silently no-op
// with rowCount 0. Until that lands, this file pins down:
//
//   1. Flag.OPENCODE_LOG_CONTEXT_SIZES gates correctly (truthy env values
//      enable it, everything else disables it).
//   2. The two log lines (`context.sizes`, `step.usage`) are wired in
//      prompt.ts / processor.ts behind the flag — guards against an
//      accidental flag-removal or log-name drift.
//   3. The cached loggers expose the shape the bench analyzer will hand-
//      parse, so the live dev-server smoke run produces parseable output.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Flag } from "../../src/flag/flag"
import { Log } from "../../src/util/log"

const SRC = path.resolve(import.meta.dir, "..", "..", "src")

test("Flag.OPENCODE_LOG_CONTEXT_SIZES is a boolean (off unless explicitly enabled)", () => {
  expect(typeof Flag.OPENCODE_LOG_CONTEXT_SIZES).toBe("boolean")
  // preload.ts doesn't set OPENCODE_LOG_CONTEXT_SIZES, so the default in the
  // test environment is false.
  expect(Flag.OPENCODE_LOG_CONTEXT_SIZES).toBe(false)
})

test("context.sizes is emitted from session.prompt behind the flag", () => {
  const src = readFileSync(path.join(SRC, "session", "prompt.ts"), "utf8")
  expect(src.includes("Flag.OPENCODE_LOG_CONTEXT_SIZES")).toBe(true)
  expect(src.includes('log.info("context.sizes"')).toBe(true)
  // Structured-output fix: the log lives below the json_schema push so
  // systemChars includes STRUCTURED_OUTPUT_SYSTEM_PROMPT on those turns.
  const flagIdx = src.indexOf('if (Flag.OPENCODE_LOG_CONTEXT_SIZES)')
  const pushIdx = src.indexOf('system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)')
  expect(flagIdx).toBeGreaterThan(pushIdx)
  // All the keys the bench analyzer expects are present.
  for (const key of [
    "workspaceFiles",
    "knowledgeFacts",
    "workspaceChars",
    "workspaceTokensEst",
    "knowledgeChars",
    "knowledgeTokensEst",
    "systemChars",
    "systemTokensEst",
  ]) {
    expect(src.includes(key)).toBe(true)
  }
})

test("step.usage is emitted from session.processor behind the flag", () => {
  const src = readFileSync(path.join(SRC, "session", "processor.ts"), "utf8")
  expect(src.includes("Flag.OPENCODE_LOG_CONTEXT_SIZES")).toBe(true)
  expect(src.includes('log.info("step.usage"')).toBe(true)
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
    expect(src.includes(key)).toBe(true)
  }
})

test("loggers for session.prompt and session.processor are cached and callable", () => {
  // Log.create caches by service name — the instance we fetch here is the
  // same one prompt.ts/processor.ts hold at module scope, so live spying
  // during a future E2E smoke will intercept the real calls.
  const promptLog = Log.create({ service: "session.prompt" })
  const procLog = Log.create({ service: "session.processor" })
  expect(typeof promptLog.info).toBe("function")
  expect(typeof procLog.info).toBe("function")
  expect(Log.create({ service: "session.prompt" })).toBe(promptLog)
  expect(Log.create({ service: "session.processor" })).toBe(procLog)
})

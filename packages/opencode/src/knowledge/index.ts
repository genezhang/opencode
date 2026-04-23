/**
 * Knowledge store helpers for OpenCode + Zengram.
 *
 * Provides write (learn) and read (recall) access to the Zengram `knowledge`
 * table. Only active when OPENCODE_STORAGE=zengram.
 */

import { generateText } from "ai"
import { zengramDb } from "@/storage/db.zengram"
import { ulid } from "ulid"
import { Log } from "@/util/log"
import { Provider } from "@/provider/provider"
import type { ProjectID } from "@/project/schema"
import type { SessionID, MessageID } from "@/session/schema"
import { EXTRACT_FACTS_SYSTEM_PROMPT, REFLECT_SYSTEM_PROMPT } from "./prompts"

const log = Log.create({ service: "knowledge" })

export type KnowledgeScope = string // "/" = global, "/project" = project-scoped

export type KnowledgeEntry = {
  id: string
  scope: string
  subject: string
  content: string
  importance: number
  source_session?: string | null
}

/**
 * Store a fact in the knowledge table.
 * Skips duplicate subjects within the same scope (simple exact match).
 */
export async function learnFact(input: {
  projectId: ProjectID
  scope: KnowledgeScope
  subject: string
  content: string
  sourceSession?: SessionID // optional — null stored for synthetic entries (e.g. reflections)
  sourceTurn?: MessageID
}): Promise<{ id: string; isNew: boolean }> {
  const db = zengramDb()
  const now = Date.now() * 1000

  // Check for exact subject duplicate in this scope
  const existing = await db.query<{ id: string; source_session: string | null }>(
    `SELECT id, source_session FROM knowledge
     WHERE project_id = $1 AND scope = $2 AND subject = $3 AND status = 'active'
     LIMIT 1`,
    [input.projectId, input.scope, input.subject],
  )
  if (existing[0]) {
    // Cross-session confirmation only fires when both sessions are known and distinct.
    const isCrossSession =
      input.sourceSession != null &&
      existing[0].source_session != null &&
      existing[0].source_session !== input.sourceSession
    if (isCrossSession) {
      // Cross-session confirmation: the same fact appeared independently in another
      // session — boost importance and confidence so it surfaces more in recall.
      await db.execute(
        `UPDATE knowledge
         SET times_confirmed = times_confirmed + 1,
             importance      = LEAST(1.0, importance + 0.15),
             confidence      = LEAST(1.0, confidence + 0.1),
             access_count    = access_count + 1,
             last_accessed   = $1,
             time_updated    = $1
         WHERE id = $2`,
        [now, existing[0].id],
      )
    } else {
      // Same session re-mention: just record access.
      await db.execute(
        `UPDATE knowledge SET access_count = access_count + 1, time_updated = $1 WHERE id = $2`,
        [now, existing[0].id],
      )
    }
    return { id: existing[0].id, isNew: false }
  }

  const id = "knw_" + ulid().toLowerCase()
  await db.execute(
    `INSERT INTO knowledge
       (id, project_id, scope, subject, content, source_type, source_session, source_turn,
        status, importance, confidence, access_count, time_created, time_updated)
     VALUES ($1,$2,$3,$4,$5,'agent',$6,$7,'active',0.7,0.8,0,$8,$9)`,
    [id, input.projectId, input.scope, input.subject, input.content,
     input.sourceSession ?? null, input.sourceTurn ?? null, now, now],
  )
  // Compute and store embedding server-side via Zeta's embed() function.
  // Fire-and-forget: embedding is best-effort; retrieval falls back to FTS if null.
  db.execute(
    `UPDATE knowledge SET embedding = embed(subject || '. ' || content) WHERE id = $1`,
    [id],
  ).catch((e) => log.warn("embed on learn failed", { id, err: e }))
  return { id, isNew: true }
}

/**
 * Fetch active knowledge for a project.
 *
 * When `context` is provided:
 *   1. Try vector similarity via Zeta's embed() — returns semantically relevant
 *      facts even without exact keyword matches, blended with importance baseline.
 *   2. Fallback to keyword (ILIKE) + importance blend if embed() is unavailable.
 * Without context: plain importance-ordered query.
 */
export async function recallFacts(input: {
  projectId: ProjectID
  scopePrefix?: string
  limit?: number
  context?: string // user message text for contextual recall
}): Promise<KnowledgeEntry[]> {
  const db = zengramDb()
  const scope = input.scopePrefix ?? "/"
  const limit = Math.min(input.limit ?? 20, 100)
  const now = Date.now() * 1000

  if (input.context) {
    // Path 1: hybrid vector + importance scoring (when embed() model is loaded).
    // score = 0.7 * (1 - cosine_dist/2) + 0.3 * importance
    // cosine distance is in [0,2] so (1 - dist/2) normalises to [0,1].
    // Rows without embeddings are excluded here; the fallback below covers them.
    try {
      const vecMatches = await db.query<KnowledgeEntry>(
        `SELECT id, scope, subject, content, importance, source_session
         FROM knowledge
         WHERE project_id = $1
           AND scope LIKE $2
           AND status = 'active'
           AND (valid_to IS NULL OR valid_to > $3)
           AND embedding IS NOT NULL
         ORDER BY (0.7 * (1.0 - (embedding <-> embed($4)) / 2.0) + 0.3 * importance) DESC
         LIMIT ${limit}`,
        [input.projectId, `${scope}%`, now, input.context],
      )

      if (vecMatches.length > 0) return vecMatches
      // No rows with embeddings → fall through to keyword path
    } catch {
      // embed() not available — fall through to keyword path
    }

    // Path 2: keyword (ILIKE) + importance blend.
    const words = input.context
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
    const keywords = [...new Set(words)].slice(0, 8)

    if (keywords.length > 0) {
      const kwLimit = Math.ceil(limit * 0.6)
      const whereParts = keywords.map((_, i) => `(subject ILIKE $${i + 4} OR content ILIKE $${i + 4})`).join(" OR ")
      const [kwMatches, baseline] = await Promise.all([
        db.query<KnowledgeEntry>(
          `SELECT id, scope, subject, content, importance, source_session
           FROM knowledge
           WHERE project_id = $1 AND scope LIKE $2 AND status = 'active'
             AND (valid_to IS NULL OR valid_to > $3) AND (${whereParts})
           ORDER BY importance DESC LIMIT ${kwLimit}`,
          [input.projectId, `${scope}%`, now, ...keywords.map((k) => `%${k}%`)],
        ),
        db.query<KnowledgeEntry>(
          `SELECT id, scope, subject, content, importance, source_session
           FROM knowledge
           WHERE project_id = $1 AND scope LIKE $2 AND status = 'active'
             AND (valid_to IS NULL OR valid_to > $3)
           ORDER BY importance DESC, access_count DESC LIMIT ${kwLimit}`,
          [input.projectId, `${scope}%`, now],
        ),
      ])
      const seen = new Set<string>()
      const merged: KnowledgeEntry[] = []
      for (const row of [...kwMatches, ...baseline]) {
        if (!seen.has(row.id)) { seen.add(row.id); merged.push(row) }
        if (merged.length >= limit) break
      }
      return merged
    }
  }

  // No context or no usable keywords: plain importance-ordered query.
  return db.query<KnowledgeEntry>(
    `SELECT id, scope, subject, content, importance, source_session
     FROM knowledge
     WHERE project_id = $1
       AND scope LIKE $2
       AND status = 'active'
       AND (valid_to IS NULL OR valid_to > $3)
     ORDER BY importance DESC, access_count DESC
     LIMIT ${limit}`,
    [input.projectId, `${scope}%`, now],
  )
}

const STOP_WORDS = new Set([
  "that", "this", "with", "have", "from", "they", "will", "been", "when",
  "your", "what", "about", "which", "there", "their", "would", "could",
  "should", "does", "into", "also", "some", "than", "then", "make",
  "just", "like", "more", "over", "such", "each", "were", "being",
])

/**
 * Semantic + keyword search over active knowledge.
 *
 * When Zeta's embed() function is available (model files loaded), uses vector
 * similarity for ranking. Falls back to ILIKE keyword search if embed() is not
 * loaded or returns an error (e.g. model files absent).
 */
export async function searchFacts(input: {
  projectId: ProjectID
  query: string
  limit?: number
}): Promise<KnowledgeEntry[]> {
  const db = zengramDb()
  const limit = Math.min(input.limit ?? 20, 100)
  const now = Date.now() * 1000

  // Hybrid vector + importance scoring (when embed() model is loaded).
  // score = 0.7 * (1 - cosine_dist/2) + 0.3 * importance
  try {
    const rows = await db.query<KnowledgeEntry>(
      `SELECT id, scope, subject, content, importance, source_session
       FROM knowledge
       WHERE project_id = $2
         AND status = 'active'
         AND (valid_to IS NULL OR valid_to > $3)
         AND embedding IS NOT NULL
       ORDER BY (0.7 * (1.0 - (embedding <-> embed($1)) / 2.0) + 0.3 * importance) DESC
       LIMIT ${limit}`,
      [input.query, input.projectId, now],
    )
    if (rows.length > 0) return rows
  } catch {
    // embed() not available; fall through to keyword search
  }

  // Fallback: ILIKE keyword search
  const pattern = `%${input.query.replace(/[%_]/g, "\\$&")}%`
  const rows = await db.query<KnowledgeEntry>(
    `SELECT id, scope, subject, content, importance, source_session
     FROM knowledge
     WHERE project_id = $1
       AND status = 'active'
       AND (valid_to IS NULL OR valid_to > $2)
       AND (subject ILIKE $3 OR content ILIKE $3)
     ORDER BY importance DESC, access_count DESC
     LIMIT ${limit}`,
    [input.projectId, now, pattern],
  )
  return rows
}

/**
 * Mark a knowledge entry as inactive or superseded.
 * Returns true if the entry was found and updated, false if not found.
 */
export async function forgetFact(input: { id: string; supersededBy?: string }): Promise<boolean> {
  const db = zengramDb()
  const now = Date.now() * 1000
  const status = input.supersededBy ? "superseded" : "inactive"

  const rowCount = input.supersededBy
    ? await db.execute(
        `UPDATE knowledge SET status = $1, valid_to = $2, superseded_by = $3, time_updated = $4 WHERE id = $5 AND status = 'active'`,
        [status, now, input.supersededBy, now, input.id],
      )
    : await db.execute(
        `UPDATE knowledge SET status = $1, valid_to = $2, time_updated = $3 WHERE id = $4 AND status = 'active'`,
        [status, now, now, input.id],
      )
  return rowCount > 0
}

// Patterns that signal a normative/durable statement worth remembering.
const NORMATIVE_RE = /\b(always|never|should(?:n't)?|must(?:n't)?|convention|important|note that|remember that|rule|policy|guideline|don't forget|be aware|best practice|recommend|prefer|avoid|use\b|don't\b)\b/i
// Sentences beginning with an imperative verb (e.g. "Use enums", "Avoid panicking")
const IMPERATIVE_START_RE = /^(?:\d+\.\s+)?\*{0,2}(Use|Avoid|Prefer|Don't|Never|Always|Make sure|Ensure|Keep|Write|Return|Handle|Check|Wrap|Implement)\b/i

/**
 * Heuristic extraction: scan assistant turn text for normative sentences.
 * Returns up to `maxFacts` extracted {subject, content} pairs.
 * No LLM call needed — purely rule-based.
 */
export function extractFacts(text: string, maxFacts = 3): Array<{ subject: string; content: string }> {
  const sentences = text
    .replace(/```[\s\S]*?```/g, "") // strip code blocks
    .replace(/\*\*/g, "")           // strip bold markers
    .split(/\n+|(?<=[.!?])\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 400)

  const hits: Array<{ subject: string; content: string }> = []
  for (const sentence of sentences) {
    if (!NORMATIVE_RE.test(sentence) && !IMPERATIVE_START_RE.test(sentence)) continue
    // Strip leading list markers and bold
    const clean = sentence.replace(/^\d+\.\s+/, "").replace(/\*\*/g, "").trim()
    const subject = clean.split(/[—\-,:;]/)[0].slice(0, 70).trim()
    if (subject.length < 8) continue
    hits.push({ subject, content: clean })
    if (hits.length >= maxFacts) break
  }
  return hits
}

/**
 * Extract facts from a completed assistant turn and persist them.
 * Called automatically after each assistant turn finishes.
 */
export async function extractAndLearn(input: {
  projectId: ProjectID
  sessionId: SessionID
  turnId: MessageID
}): Promise<number> {
  const db = zengramDb()

  // Gather text from all text-type parts for this turn. Zeta returns JSONB
  // columns as stringified JSON, so we always parse and read the `.text`
  // field — using the raw JSON string as "text" made extractFacts run
  // against JSON scaffolding instead of the model's prose.
  const parts = await db.query<{ data: any }>(
    `SELECT data FROM part WHERE turn_id = $1 AND type = 'text' ORDER BY position ASC`,
    [input.turnId],
  )
  const fullText = parts
    .map((p) => {
      const data = typeof p.data === "string" ? JSON.parse(p.data) : p.data
      return (data as { text?: string } | null)?.text ?? ""
    })
    .join("\n")
    .trim()

  if (fullText.length < 100) return 0 // Too short to extract from

  // Heuristic extraction runs on every turn.
  const heuristicFacts = extractFacts(fullText)

  // LLM extraction runs on high-value turns (>2 000 chars) — better quality,
  // but costs a cheap model call. Fire-and-forget from caller's perspective;
  // we await it here since extractAndLearn is already called fire-and-forget.
  const llmFacts = fullText.length >= 2000 ? await extractFactsWithLlm(fullText) : []

  const facts = mergeExtracted(heuristicFacts, llmFacts)
  log.info("passive extraction", {
    turnId: input.turnId,
    textLen: fullText.length,
    heuristic: heuristicFacts.length,
    llm: llmFacts.length,
    total: facts.length,
  })

  let stored = 0
  for (const fact of facts) {
    const { isNew } = await learnFact({
      projectId: input.projectId,
      scope: "/project",
      subject: fact.subject,
      content: fact.content,
      sourceSession: input.sessionId,
      sourceTurn: input.turnId,
    })
    if (isNew) stored++
  }
  log.info("passive extraction done", { turnId: input.turnId, stored })

  // After storing new facts, opportunistically synthesize higher-level patterns.
  // reflectKnowledge() has its own minFacts guard (total active facts >= 5) and is
  // throttled to once per 6 hours — safe to call fire-and-forget on every turn.
  if (stored > 0) {
    reflectKnowledge({ projectId: input.projectId })
      .catch((e) => log.warn("reflection failed", { err: e }))
  }

  return stored
}

/**
 * Use a cheap LLM call to extract up to 5 durable facts from a turn.
 * Returns [] on any failure (model unavailable, parse error, etc.).
 */
async function extractFactsWithLlm(text: string): Promise<Array<{ subject: string; content: string }>> {
  try {
    const modelRef = await Provider.defaultModel()
    const smallModel = await Provider.getSmallModel(modelRef.providerID)
    const fullModel = smallModel ?? (await Provider.getModel(modelRef.providerID, modelRef.modelID))
    const language = await Provider.getLanguage(fullModel)

    const { text: output } = await generateText({
      model: language,
      system: EXTRACT_FACTS_SYSTEM_PROMPT,
      prompt: text.slice(0, 4000),
    })

    const cleaned = output.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim()
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (f): f is { subject: string; content: string } =>
        typeof f?.subject === "string" && typeof f?.content === "string",
    )
  } catch (e) {
    log.warn("llm extraction failed", { err: e })
    return []
  }
}

/** Merge heuristic + LLM facts, deduping by subject. LLM facts take priority. */
function mergeExtracted(
  heuristic: Array<{ subject: string; content: string }>,
  llm: Array<{ subject: string; content: string }>,
): Array<{ subject: string; content: string }> {
  const seen = new Set<string>()
  const out: Array<{ subject: string; content: string }> = []
  for (const f of [...llm, ...heuristic]) {
    const key = f.subject.toLowerCase().slice(0, 40)
    if (!seen.has(key)) { seen.add(key); out.push(f) }
    if (out.length >= 8) break
  }
  return out
}

// Track when decay last ran per project to avoid running it on every turn.
const _lastDecayRun = new Map<string, number>()
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000 // at most once per day per project

/**
 * Exponential importance decay on all active knowledge for a project.
 * Mirrors the Rust decay.rs logic: importance *= 0.5 ^ (elapsed_days / half_life_days).
 * Throttled to run at most once per day per project — safe to call fire-and-forget.
 */
export async function decayKnowledge(input: {
  projectId: ProjectID
  halfLifeDays?: number
}): Promise<number> {
  const now = Date.now()
  const lastRun = _lastDecayRun.get(input.projectId) ?? 0
  if (now - lastRun < DECAY_INTERVAL_MS) return 0

  const db = zengramDb()
  const halfLife = input.halfLifeDays ?? 30
  const nowMicros = now * 1000
  const microsPerDay = 86_400_000_000

  const count = await db.execute(
    `UPDATE knowledge
     SET importance = importance * POWER(0.5,
           CAST(($1 - COALESCE(last_accessed, time_created)) AS DOUBLE PRECISION)
           / ${microsPerDay}
           / ${halfLife}),
         last_accessed = $1,
         time_updated = $1
     WHERE project_id = $2
       AND status = 'active'
       AND importance > 0.01`,
    [nowMicros, input.projectId],
  )
  _lastDecayRun.set(input.projectId, now)
  log.info("knowledge decay", { projectId: input.projectId, updated: count })
  return count
}

/**
 * Backfill embeddings for all active knowledge entries that have no embedding.
 * Calls Zeta's embed() server-side — safe to call fire-and-forget after startup.
 * Returns the number of rows updated.
 */
export async function backfillEmbeddings(_input?: { projectId?: ProjectID }): Promise<number> {
  const db = zengramDb()
  try {
    // No project_id filter — embed all active rows that lack an embedding.
    // Safe to re-run: WHERE embedding IS NULL makes it a no-op once caught up.
    return await db.execute(
      `UPDATE knowledge
       SET embedding = embed(subject || '. ' || content)
       WHERE status = 'active'
         AND embedding IS NULL`,
      [],
    )
  } catch (e) {
    log.warn("backfillEmbeddings failed (embed() may not be loaded yet)", { err: e })
    return 0
  }
}

/**
 * Format recalled knowledge as a system-prompt block.
 * Returns null if there's nothing to inject.
 */
export function formatKnowledgeBlock(facts: KnowledgeEntry[]): string | null {
  if (facts.length === 0) return null
  const lines = facts.map((f) => `- **${f.subject}**: ${f.content}`)
  return `<zengram-knowledge>\nThe following facts were recalled from persistent memory:\n${lines.join("\n")}\n</zengram-knowledge>`
}

// ── Reflection ────────────────────────────────────────────────────────────────

// Throttle reflection to at most once every 6 hours per project.
const _lastReflectRun = new Map<string, number>()
const REFLECT_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Synthesize higher-level patterns from recent knowledge and store them back.
 * Throttled to run at most once per 6 hours per project.
 * Called fire-and-forget from extractAndLearn after new facts are stored.
 */
export async function reflectKnowledge(input: {
  projectId: ProjectID
  minFacts?: number // skip if fewer than this many active knowledge entries
}): Promise<number> {
  const now = Date.now()
  const lastRun = _lastReflectRun.get(input.projectId) ?? 0
  if (now - lastRun < REFLECT_INTERVAL_MS) return 0

  const db = zengramDb()
  const minFacts = input.minFacts ?? 5

  // Fetch recent active knowledge to reflect on.
  const rows = await db.query<{ subject: string; content: string }>(
    `SELECT subject, content FROM knowledge
     WHERE project_id = $1 AND status = 'active'
     ORDER BY importance DESC, time_updated DESC
     LIMIT 20`,
    [input.projectId],
  )
  if (rows.length < minFacts) return 0

  // Mark as attempted before the LLM call so concurrent turns don't pile up
  // and a model that repeatedly returns non-JSON doesn't spam on every turn.
  _lastReflectRun.set(input.projectId, now)

  let insights: Array<{ subject: string; content: string }> = []
  try {
    const modelRef = await Provider.defaultModel()
    const smallModel = await Provider.getSmallModel(modelRef.providerID)
    const fullModel = smallModel ?? (await Provider.getModel(modelRef.providerID, modelRef.modelID))
    const language = await Provider.getLanguage(fullModel)

    const factList = rows.map((r) => `- ${r.subject}: ${r.content}`).join("\n")
    const { text: output } = await generateText({
      model: language,
      system: REFLECT_SYSTEM_PROMPT,
      prompt: `Known facts:\n${factList}`,
    })

    const cleaned = output.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim()
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return 0
    insights = parsed
      .filter(
        (f): f is { subject: string; content: string } =>
          typeof f?.subject === "string" && typeof f?.content === "string",
      )
      .map((f) => ({ subject: f.subject.trim(), content: f.content.trim() }))
      .filter((f) => f.subject.length > 0 && f.content.length > 0)
      .slice(0, 3)
  } catch (e) {
    log.warn("reflection failed", { err: e })
    return 0
  }

  let stored = 0
  for (const insight of insights) {
    try {
      const { isNew } = await learnFact({
        projectId: input.projectId,
        scope: "/project",
        subject: insight.subject,
        content: insight.content,
        // sourceSession/sourceTurn are omitted — reflection has no FK-valid origin.
      })
      if (isNew) stored++
    } catch (e) {
      log.warn("reflection store failed", { err: e })
    }
  }
  log.info("reflection done", { projectId: input.projectId, stored })
  return stored
}

// ── Workspace context ─────────────────────────────────────────────────────────

export type WorkspaceFileEntry = {
  file_path: string
  understanding: string // 'deep' | 'read' | 'listed' | 'unknown'
  edit_state: string   // 'modified' | 'clean' | 'deleted'
  relevance: number
}

/**
 * Fetch files touched in this session, ordered by recency and edit state.
 * Modified files surface first, then deeply-read files, then others.
 */
export async function recallWorkspaceContext(input: {
  sessionId: SessionID
  limit?: number
}): Promise<WorkspaceFileEntry[]> {
  const db = zengramDb()
  // Validate before interpolation (Zeta plan-cache bug requires LIMIT to be
  // string-interpolated, not parameterized — so NaN/Infinity must be guarded).
  const rawLimit = input.limit
  const limit = Number.isFinite(rawLimit) && rawLimit! > 0
    ? Math.min(Math.floor(rawLimit!), 100)
    : 30

  return db.query<WorkspaceFileEntry>(
    `SELECT file_path, understanding, edit_state, relevance
     FROM workspace_file
     WHERE session_id = $1
     ORDER BY
       CASE edit_state WHEN 'modified' THEN 0 WHEN 'deleted' THEN 1 ELSE 2 END,
       CASE understanding WHEN 'deep' THEN 0 WHEN 'read' THEN 1 ELSE 2 END,
       relevance DESC,
       time_updated DESC
     LIMIT ${limit}`,
    [input.sessionId],
  )
}

/**
 * Format workspace file context as a system-prompt block.
 * Returns null if no files have been touched.
 */
/** Sanitize a file path for safe inclusion in an XML-like prompt block. */
function sanitizePath(p: string): string {
  return p
    .replace(/&/g, "&amp;")   // must come first before other entity replacements
    .replace(/[\r\n\t]/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function formatWorkspaceBlock(files: WorkspaceFileEntry[]): string | null {
  if (files.length === 0) return null

  const modified = files.filter((f) => f.edit_state === "modified" || f.edit_state === "deleted")
  const unmodified = files.filter((f) => f.edit_state !== "modified" && f.edit_state !== "deleted")
  // Distinguish actually-read files from those only listed (e.g. directory scans).
  const read   = unmodified.filter((f) => f.understanding === "deep" || f.understanding === "read")
  const listed = unmodified.filter((f) => f.understanding === "listed")

  const lines: string[] = []
  if (modified.length > 0) {
    lines.push("Modified in this session:")
    for (const f of modified) {
      const tag = f.edit_state === "deleted" ? " (deleted)" : ""
      lines.push(`  - ${sanitizePath(f.file_path)}${tag}`)
    }
  }
  if (read.length > 0) {
    lines.push("Read in this session:")
    for (const f of read.slice(0, 10)) lines.push(`  - ${sanitizePath(f.file_path)}`)
  }
  if (listed.length > 0) {
    lines.push("Directories listed in this session:")
    for (const f of listed.slice(0, 5)) lines.push(`  - ${sanitizePath(f.file_path)}`)
  }

  if (lines.length === 0) return null
  return `<zengram-workspace>\n${lines.join("\n")}\n</zengram-workspace>`
}

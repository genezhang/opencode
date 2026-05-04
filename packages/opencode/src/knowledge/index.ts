/**
 * Knowledge store helpers for OpenCode + Zengram.
 *
 * Provides write (learn) and read (recall) access to the Zengram `knowledge`
 * table. Only active when OPENCODE_STORAGE=zengram.
 */

import { generateText } from "ai"
import path from "node:path"
import { zengramDb, type Queryable } from "@/storage/db.zengram"
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
  /**
   * Cosine distance (range [0, 2]) to the recall query's embedding. Populated
   * only on the vector-path of `recallFacts`; absent on keyword/baseline
   * paths and on `learnFact` returns. May be null when embed() returned NULL
   * for the query (e.g. embedding pipeline broken). Lower = more similar.
   */
  distance?: number | null
}

/**
 * Distance gate for recallFacts (default: off). When ZENGRAM_FACT_MAX_DISTANCE
 * is set to a positive number, vector-path facts whose embedding distance
 * to the query exceeds the threshold are dropped — analogous to
 * ZENGRAM_PLAY_MAX_DISTANCE for plays. Distance is in [0, 2] (cosine).
 *
 * Off by default because the right cutoff for facts isn't yet empirically
 * established and we don't want to silently change behavior. Bench cycles
 * can probe values via the env var.
 */
function factDistanceMax(): number {
  const raw = process.env["ZENGRAM_FACT_MAX_DISTANCE"]
  if (!raw) return Number.POSITIVE_INFINITY
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY
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
    //
    // Distance is also pulled out as a column so we can gate JS-side. Zeta has
    // shown edge cases where SQL-level WHERE on `embedding <-> embed(...)`
    // misbehaves — recallPlays uses the same compute-once-then-filter pattern.
    try {
      const maxDist = factDistanceMax()
      // Wrap in a subquery so embed($4) is computed once (as the `distance`
      // alias) and reused by the ORDER BY scoring expression. The flat form
      // re-invoked embed($4) inside ORDER BY, doubling the embedding cost
      // per recall when Zeta doesn't CSE the call. recallPlays uses the same
      // alias-reuse pattern (ORDER BY distance ASC).
      const vecMatches = await db.query<KnowledgeEntry>(
        `SELECT id, scope, subject, content, importance, source_session, distance FROM (
           SELECT id, scope, subject, content, importance, source_session,
                  (embedding <-> embed($4)) AS distance
           FROM knowledge
           WHERE project_id = $1
             AND scope LIKE $2
             AND status = 'active'
             AND (valid_to IS NULL OR valid_to > $3)
             AND embedding IS NOT NULL
         ) sub
         ORDER BY (0.7 * (1.0 - distance / 2.0) + 0.3 * importance) DESC
         LIMIT ${limit}`,
        [input.projectId, `${scope}%`, now, input.context],
      )

      // Gate: when ZENGRAM_FACT_MAX_DISTANCE is set, drop facts whose distance
      // exceeds the threshold. NULL distance means embed() failed for this
      // query — fail closed (drop) so a broken embedding pipeline doesn't
      // bypass the gate. Default (env unset) keeps all rows by leaving maxDist
      // = +Infinity.
      const gated = Number.isFinite(maxDist)
        ? vecMatches.filter((r) => r.distance != null && r.distance <= maxDist)
        : vecMatches
      if (Number.isFinite(maxDist)) {
        log.info("recallFacts gated", {
          total: vecMatches.length,
          kept: gated.length,
          maxDist,
        })
      }

      if (gated.length > 0) return gated
      // No rows passed the gate (or no rows had embeddings) → fall through
      // to keyword path so we still return *something* relevant by token.
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

// ── Plays (successful session shortcuts) ─────────────────────────────────────
//
// A "play" is the compact record of a session that actually did work: the
// problem statement it tackled + the files it touched (modified / read). When
// a new session starts on a semantically similar problem, Zengram recalls the
// top-N most similar plays and injects their file lists as a
// <zengram-previously-helpful> block so the agent can skip the exploration
// phase. Stored in the `knowledge` table with scope="/play" so we inherit
// embedding indexing + decay + lifecycle management for free.
//
// Rationale: exactly-matching tasks are rare; similar tasks are common. The
// value is "last time a Django migration FK-dependency bug showed up, these
// files were the fix" — concrete, task-anchored, directly actionable.

export type PlayEntry = {
  id: string
  subject: string       // first ~120 chars of the problem statement
  content: string       // rendered file list
  source_session: string | null
  importance: number
  distance?: number     // L2 distance to query embedding; lower = more similar
}

const PLAY_SCOPE = "/play"
const PLAY_SUBJECT_MAX = 120

function playSubjectForSession(sessionId: string, problem: string): string {
  // Use a session-scoped prefix so the same session can UPSERT its own row.
  // The problem-statement excerpt is the semantic payload for embedding.
  const excerpt = problem.replace(/\s+/g, " ").trim().slice(0, PLAY_SUBJECT_MAX)
  return `[${sessionId}] ${excerpt}`
}

interface EditChange {
  file: string
  oldString: string
  newString: string
}

function renderPlayContent(
  files: WorkspaceFileEntry[],
  edits: EditChange[],
  rootDir?: string,
): string {
  // Compact format: a play is most useful as a "go look at THIS file" pointer
  // plus a hint at the diff shape. Tool-sequence narrative and deep-read file
  // lists added bytes without changing model behavior in the bench (still
  // 5–6 turns regardless), and every byte hurts the prefix KV cache. Keep
  // file list + diff preview only.
  const modified = files.filter((f) => f.edit_state === "modified" || f.edit_state === "deleted")
  // Fall back to deriving the modified-file list from edits when workspace_file
  // hasn't projected yet — same race as the tool_call lag we work around in
  // buildEditChanges. Each edit's filePath is enough to surface "look here".
  const modifiedPaths: string[] = modified.length > 0
    ? modified.map((f) => `${sanitizePath(toRepoRelative(f.file_path, rootDir))}${f.edit_state === "deleted" ? " (deleted)" : ""}`)
    : Array.from(new Set(edits.map((e) => sanitizePath(toRepoRelative(e.file, rootDir)))))
  const lines: string[] = []
  if (modifiedPaths.length > 0) lines.push(`Files modified: ${modifiedPaths.join(", ")}`)
  if (edits.length > 0) {
    for (const e of edits) {
      lines.push(`In ${sanitizePath(toRepoRelative(e.file, rootDir))} the working change was:`)
      // Escape the edit preview the same way as paths — code snippets routinely
      // contain `<`, `>`, `&` (generics, JSX, comparisons) which would otherwise
      // break out of the <zengram-previously-helpful> tag wrapper applied by
      // formatPlaysBlock. sanitizePath despite the name is a generic
      // XML-block escaper; truncateForPlay already collapsed whitespace so the
      // newline stripping is a no-op here.
      lines.push(`  ${sanitizePath(truncateForPlay(e.newString))}`)
    }
  }
  return lines.join("\n")
}

const EDIT_PREVIEW_MAX = 600

function truncateForPlay(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim()
  return collapsed.length > EDIT_PREVIEW_MAX
    ? collapsed.slice(0, EDIT_PREVIEW_MAX - 3) + "..."
    : collapsed
}

/**
 * Make a path repo-relative for display in plays. Mirrors the pattern used in
 * tool/apply_patch.ts (path.relative + replaceAll) so plays are stable across
 * platforms and don't show absolute paths or backslash separators on Windows.
 */
function toRepoRelative(file: string, rootDir?: string): string {
  if (!rootDir) return file
  const rel = path.relative(rootDir, file).replaceAll("\\", "/")
  // path.relative returns "..", "../foo" etc when `file` lives outside rootDir;
  // keep the original absolute path in that case so plays don't render
  // misleading "../../tmp/..." breadcrumbs.
  if (rel.startsWith("..") || path.isAbsolute(rel)) return file.replaceAll("\\", "/")
  return rel
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

/**
 * Fetch the edits that actually landed in this session. Each `edit` /
 * `multiedit` tool call carries `{filePath, oldString, newString}` in its
 * input — that's the structured diff we want to surface to future sessions.
 * Caps the total return at EDIT_CAPTURE_MAX edits so a runaway edit loop
 * doesn't blow up the play content.
 */
const EDIT_CAPTURE_MAX = 3

async function buildEditChanges(
  db: Queryable,
  sessionId: SessionID,
): Promise<EditChange[]> {
  // Query the `part` table, not `tool_call`. Parts are written synchronously
  // when each tool result arrives, so they're visible to recordPlay's
  // fire-and-forget reads on the very next turn. tool_call is projected from
  // a different event and the dj-12713 sweep showed it could lag enough that
  // short sessions (3–6 tool calls, edit near the end) finish before the
  // edit row commits — leaving plays with file paths only.
  //
  // The JOIN explicitly aliases `p.data AS data` because Zeta's result-set
  // column naming surfaces JOIN-side columns as "p.data" rather than "data"
  // unless aliased; without the alias `r.data` is undefined and no edits get
  // captured. Same trick applies anywhere in this file we read columns from
  // a JOIN-qualified select.
  //
  // Each tool-call part stores the call as JSON in `data`:
  //   { state: { input: {filePath, oldString, newString | content}, ... }, ... }
  // The `tool` field on the JSON tells us which tool was invoked.
  const rows = await db.query<{ data: any }>(
    `SELECT p.data AS data FROM part p
     JOIN turn t ON p.turn_id = t.id
     WHERE t.session_id = $1 AND p.type = 'tool'
     ORDER BY t.time_created ASC, p.position ASC`,
    [sessionId],
  )
  const out: EditChange[] = []
  outer: for (const r of rows) {
    const parsed = typeof r.data === "string" ? safeParse(r.data) : r.data
    if (!parsed || typeof parsed !== "object") continue
    const partRec = parsed as Record<string, unknown>
    const tool = typeof partRec.tool === "string" ? partRec.tool : ""
    if (tool !== "edit" && tool !== "multiedit" && tool !== "write") continue
    const state = partRec.state as Record<string, unknown> | undefined
    if (!state || (state.status !== "completed" && state.status !== "success")) continue
    const inp = state.input as Record<string, unknown> | undefined
    if (!inp) continue
    const file = typeof inp.filePath === "string" ? inp.filePath : ""
    if (!file) continue
    if (tool === "write" && typeof inp.content === "string") {
      out.push({ file, oldString: "", newString: inp.content })
    } else if (tool === "multiedit" && Array.isArray(inp.edits)) {
      // multiedit's schema is { filePath, edits: [{oldString, newString, ...}] }.
      // Each entry is a discrete edit; surface them individually so plays show
      // the same "the working change was: <preview>" per edit as plain edit calls.
      for (const e of inp.edits as Array<Record<string, unknown>>) {
        if (typeof e?.oldString !== "string" || typeof e?.newString !== "string") continue
        out.push({ file, oldString: e.oldString, newString: e.newString })
        if (out.length >= EDIT_CAPTURE_MAX) break outer
      }
      continue
    } else if (typeof inp.oldString === "string" && typeof inp.newString === "string") {
      out.push({ file, oldString: inp.oldString, newString: inp.newString })
    }
    if (out.length >= EDIT_CAPTURE_MAX) break
  }
  return out
}

/**
 * Record a play for a completed session. Fire-and-forget: exceptions are
 * logged but never propagated — the whole body is wrapped in a try/catch so
 * any DB / JSON parse / embed failure just produces a warn and returns.
 * Idempotent: called on every assistant-turn finish, UPSERTs the same row so
 * the latest state wins.
 *
 * No-ops silently if the session has no problem statement or no modified /
 * deep-read files (nothing useful to record).
 */
export async function recordPlay(input: {
  projectId: ProjectID
  sessionId: SessionID
  rootDir?: string
}): Promise<void> {
  try {
    const db = zengramDb()
    const now = Date.now() * 1000

    // Problem statement: the first user-message text part for this session,
    // with the session.title as a fallback when the user-turn row isn't
    // visible yet (projectAsync ordering isn't guaranteed — we've seen
    // recordPlay fire on an assistant-finish before the user turn's
    // MessageV2.Event.Updated projector committed). resolveProblem performs
    // the lookup as two queries (turn → part) rather than a single JOIN
    // because Zeta surfaces JOIN columns keyed as "p.<col>" rather than
    // "<col>" unless aliased — splitting sidesteps the alias requirement on
    // a fire-and-forget path; see buildEditChanges for the alias-based
    // alternative used where a JOIN is the natural shape.
    const problem = await resolveProblem(db, input.sessionId)
    if (!problem || problem.length < 20) {
      log.info("recordPlay skipped: short problem", { sessionId: input.sessionId, len: problem?.length ?? 0 })
      return
    }

    const files = await db.query<WorkspaceFileEntry>(
      `SELECT file_path, understanding, edit_state, relevance
       FROM workspace_file
       WHERE session_id = $1
       ORDER BY
         CASE edit_state WHEN 'modified' THEN 0 WHEN 'deleted' THEN 1 ELSE 2 END,
         CASE understanding WHEN 'deep' THEN 0 WHEN 'read' THEN 1 ELSE 2 END`,
      [input.sessionId],
    )
    const edits = await buildEditChanges(db, input.sessionId)
    const content = renderPlayContent(files, edits, input.rootDir)
    if (content.length === 0) {
      log.info("recordPlay skipped: no useful files", { sessionId: input.sessionId, fileRows: files.length })
      return
    }

    const subject = playSubjectForSession(input.sessionId, problem)

    // Deterministic id keyed off the session so repeated recordPlay calls
    // within a session hit the same row via ON CONFLICT DO UPDATE — no
    // SELECT-then-INSERT race on MVCC visibility (Zeta can fail to surface
    // our own prior INSERT to the same-session SELECT, producing duplicate
    // rows instead of updating).
    const id = `knw_play_${input.sessionId}`

    // Skip the write (and the expensive re-embed) when nothing changed.
    // recordPlay fires on every assistant finish; most of those don't produce
    // new files or edits. Compare subject AND content: an early call can hit
    // the session.title fallback in resolveProblem (different subject) while
    // the content stays the same; we still want to refresh the embedding
    // when subject changes since embed() runs over `subject || '. ' || content`.
    const existing = await db.query<{ subject: string; content: string }>(
      `SELECT subject, content FROM knowledge WHERE id = $1`,
      [id],
    )
    if (existing.length > 0 && existing[0].subject === subject && existing[0].content === content) {
      return
    }
    await db.execute(
      `INSERT INTO knowledge
         (id, project_id, scope, subject, content, source_type, source_session,
          status, importance, confidence, access_count, time_created, time_updated)
       VALUES ($1,$2,$3,$4,$5,'agent',$6,'active',0.8,0.9,0,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         subject = EXCLUDED.subject,
         content = EXCLUDED.content,
         time_updated = EXCLUDED.time_updated`,
      [id, input.projectId, PLAY_SCOPE, subject, content, input.sessionId, now, now],
    )
    // Refresh embedding so vector recall matches the latest content. Inner
    // fire-and-forget; vector recall still works if it fails (the row is
    // written either way).
    db.execute(
      `UPDATE knowledge SET embedding = embed(subject || '. ' || content) WHERE id = $1`,
      [id],
    ).catch((e) => log.warn("play embedding refresh failed", { err: e }))
    log.info("recordPlay wrote", { sessionId: input.sessionId, id, contentLen: content.length })
  } catch (err) {
    log.warn("recordPlay failed", { sessionId: input.sessionId, err })
  }
}

/**
 * Resolve the user-provided problem statement for a session. Preferred path
 * is the first user turn's text part; falls back to session.title when the
 * user-turn row isn't visible yet (event-ordering race during very early
 * recordPlay calls). Returns empty string if nothing usable.
 */
async function resolveProblem(db: Queryable, sessionId: SessionID): Promise<string> {
  const firstUserTurn = await db.query<{ id: string }>(
    `SELECT id FROM turn
     WHERE session_id = $1 AND role = 'user'
     ORDER BY time_created ASC
     LIMIT 1`,
    [sessionId],
  )
  if (firstUserTurn.length > 0) {
    const parts = await db.query<{ data: any }>(
      `SELECT data FROM part
       WHERE turn_id = $1 AND type = 'text'
       ORDER BY position ASC
       LIMIT 1`,
      [firstUserTurn[0].id],
    )
    if (parts.length > 0) {
      const raw = parts[0].data
      const decoded = typeof raw === "string" ? (safeParse(raw) as { text?: string } | null) : raw
      const text = (decoded as { text?: string } | null)?.text ?? ""
      if (text.length >= 20) return text
    }
  }
  // Fallback: session.title is populated early and survives projector races.
  const sessRows = await db.query<{ title: string | null }>(
    `SELECT title FROM session WHERE id = $1 LIMIT 1`,
    [sessionId],
  )
  return sessRows[0]?.title ?? ""
}

/**
 * Recall the top-N plays most semantically similar to the current problem
 * statement. Falls through to empty on any error — plays are a bonus signal,
 * not critical-path.
 *
 * Filters out self (excludeSessionId) so a session can't recall its own play.
 * This matters during a single session: recordPlay fires on every turn and
 * would otherwise surface the current session's own file list as a "hint".
 */
// Per-session memo so plays-block content stays byte-stable within the
// lifetime of one user message. llama.cpp's prefix KV cache only reuses if
// the prompt prefix matches exactly; if recall returned a different
// (or differently-ordered) set during the same user turn, prompt-processing
// cost would be paid in full each call.
//
// Keyed by (sessionId, queryText) — when the user posts a follow-up message
// the queryText changes and recall correctly re-fires. Keying by sessionId
// alone (an earlier shape) cached too aggressively and returned stale plays
// for the original problem after the user moved on.
//
// FIFO-bounded so long-running modes (`opencode serve`) don't accumulate
// entries indefinitely. Capacity 64 is an order of magnitude larger than
// realistic concurrent-session counts; ended sessions either fall off
// naturally as new ones land, or pay one extra DB round-trip after eviction
// — both acceptable. JS Map preserves insertion order, so the first key is
// the oldest entry.
const PLAYS_CACHE_MAX = 64
const playsBySession = new Map<SessionID, { queryText: string; plays: PlayEntry[] }>()
function rememberPlays(sessionId: SessionID, queryText: string, plays: PlayEntry[]): void {
  if (playsBySession.size >= PLAYS_CACHE_MAX && !playsBySession.has(sessionId)) {
    const oldest = playsBySession.keys().next().value
    if (oldest !== undefined) playsBySession.delete(oldest)
  }
  playsBySession.set(sessionId, { queryText, plays })
}

// Similarity gate: drop plays whose L2 distance to the current problem
// embedding exceeds this. Empirical observation on this codebase with
// BGE-small embeddings: same problem ≈ 0.1–0.2, same Django subsystem ≈
// 0.4–0.5, cross-domain Django (e.g. admin vs datastructures) ≈ 0.60+.
// Default 0.5 keeps same-task and tightly-related plays, drops cross-domain
// Django plays — verified on the dj-14089 ↔ dj-12713 pair where unrelated
// plays surfaced at distance ≈ 0.61 with no behavioral upside.
// Override via ZENGRAM_PLAY_MAX_DISTANCE for tuning.
const PLAY_DISTANCE_DEFAULT = 0.5

function playDistanceMax(): number {
  const raw = process.env["ZENGRAM_PLAY_MAX_DISTANCE"]
  if (!raw) return PLAY_DISTANCE_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : PLAY_DISTANCE_DEFAULT
}

export async function recallPlays(input: {
  projectId: ProjectID
  problem: string
  excludeSessionId?: SessionID
  limit?: number
}): Promise<PlayEntry[]> {
  if (!input.problem || input.problem.length < 20) return []
  // Strip a leading bench/agent preamble before embedding the query.
  // Symptom we saw on the dj-12713/dj-14089 suite: a fixed ~1.5KB BENCH_PREAMBLE
  // is prepended to every problem, so embed(userText) gets dominated by the
  // preamble bytes — making cross-task and same-task queries land at almost
  // identical distances (~0.61) and breaking the similarity gate. The
  // convention in the preamble is "<instructions>\n\n---\n\n<problem>", so
  // splitting on the LAST `---` separator pulls out the task-specific tail
  // when present and is a no-op when absent.
  const sepIdx = input.problem.lastIndexOf("\n---\n")
  const queryText = sepIdx >= 0 ? input.problem.slice(sepIdx + 5).trim() : input.problem
  // Cache lookup AFTER queryText is computed, so the cache key matches what
  // would have driven the embedding query. Only return cached plays when both
  // the session AND the problem text match — same session with a follow-up
  // user message must re-fire recall.
  if (input.excludeSessionId) {
    const cached = playsBySession.get(input.excludeSessionId)
    if (cached && cached.queryText === queryText) return cached.plays
  }
  const db = zengramDb()
  const limit = Math.min(input.limit ?? 3, 10)
  const now = Date.now() * 1000
  const maxDist = playDistanceMax()

  try {
    // Pull distance alongside the row so we can gate in JS — Zeta has shown
    // edge cases where a SQL-level WHERE on `embedding <-> embed(...)`
    // misbehaves; computing once and filtering JS-side is robust.
    const rows = await db.query<PlayEntry>(
      `SELECT id, subject, content, source_session, importance,
              (embedding <-> embed($5)) AS distance
       FROM knowledge
       WHERE project_id = $1
         AND scope = $2
         AND status = 'active'
         AND (valid_to IS NULL OR valid_to > $3)
         AND embedding IS NOT NULL
         AND ($4::text IS NULL OR source_session IS NULL OR source_session != $4)
       ORDER BY distance ASC
       LIMIT ${limit}`,
      [input.projectId, PLAY_SCOPE, now, input.excludeSessionId ?? null, queryText],
    )
    // Fail closed on NULL distance: if embed($5) returned NULL (e.g. provider
    // unregistered, model load failure, embedding pipeline broken), every row
    // comes back with distance=NULL and the prior `distance == null ||` form
    // would inject every play in the table regardless of similarity. Drop
    // those rows so a broken embedding pipeline produces empty recall, not
    // arbitrary plays.
    const gated = rows.filter((r) => r.distance != null && r.distance <= maxDist)
    log.info("recallPlays gated", {
      total: rows.length,
      kept: gated.length,
      maxDist,
      distances: rows.map((r) => (r.distance == null ? null : Number(r.distance.toFixed(3)))),
    })
    if (input.excludeSessionId) rememberPlays(input.excludeSessionId, queryText, gated)
    return gated
  } catch (e) {
    log.warn("recallPlays failed", { err: e })
    return []
  }
}

/**
 * Render recalled plays as a <zengram-previously-helpful> block. Null when
 * no plays → no block in the system prompt.
 *
 * Subjects are user-supplied problem-statement text, so run them through
 * `sanitizePath` (which escapes `&`, `<`, `>` and strips control chars) to
 * prevent prompt-tag injection or accidental `</zengram-...>` closure.
 * Content was already sanitized at recordPlay time.
 */
export function formatPlaysBlock(plays: PlayEntry[]): string | null {
  if (plays.length === 0) return null

  const lines: string[] = [
    "Similar past sessions on this project were solved with the file changes below.",
    "Read these files first before broad exploration — the problem domain overlaps.",
    "",
  ]
  for (const play of plays) {
    // Strip the "[session_id] " prefix from the stored subject, then escape.
    const cleanSubject = sanitizePath(play.subject.replace(/^\[[^\]]+\]\s*/, ""))
    lines.push(`From a similar problem: "${cleanSubject.slice(0, 100)}${cleanSubject.length > 100 ? "…" : ""}"`)
    // Content is already the formatted file list.
    for (const line of play.content.split("\n")) lines.push(`  ${line}`)
    lines.push("")
  }
  return `<zengram-previously-helpful>\n${lines.join("\n").trimEnd()}\n</zengram-previously-helpful>`
}

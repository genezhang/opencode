/**
 * Knowledge store helpers for OpenCode + Zengram.
 *
 * Provides write (learn) and read (recall) access to the Zengram `knowledge`
 * table. Only active when OPENCODE_STORAGE=zengram.
 */

import { zengramDb } from "@/storage/db.zengram"
import { ulid } from "ulid"
import { Log } from "@/util/log"
import type { ProjectID } from "@/project/schema"
import type { SessionID, MessageID } from "@/session/schema"

const log = Log.create({ service: "knowledge" })

export type KnowledgeScope = string // "/" = global, "/project" = project-scoped

export type KnowledgeEntry = {
  id: string
  scope: string
  subject: string
  content: string
  importance: number
  source_session?: string
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
  sourceSession: SessionID
  sourceTurn: MessageID
}): Promise<{ id: string; isNew: boolean }> {
  const db = zengramDb()
  const now = Date.now() * 1000

  // Check for exact subject duplicate in this scope
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM knowledge
     WHERE project_id = $1 AND scope = $2 AND subject = $3 AND status = 'active'
     LIMIT 1`,
    [input.projectId, input.scope, input.subject],
  )
  if (existing[0]) {
    // Bump access count and update timestamp
    await db.execute(
      `UPDATE knowledge SET access_count = access_count + 1, time_updated = $1 WHERE id = $2`,
      [now, existing[0].id],
    )
    return { id: existing[0].id, isNew: false }
  }

  const id = "knw_" + ulid().toLowerCase()
  await db.execute(
    `INSERT INTO knowledge
       (id, project_id, scope, subject, content, source_type, source_session, source_turn,
        status, importance, confidence, access_count, time_created, time_updated)
     VALUES ($1,$2,$3,$4,$5,'agent',$6,$7,'active',0.7,0.8,0,$8,$9)`,
    [id, input.projectId, input.scope, input.subject, input.content,
     input.sourceSession, input.sourceTurn, now, now],
  )
  return { id, isNew: true }
}

/**
 * Fetch active knowledge for a project.
 * When `context` is provided, blends keyword-matched facts with importance-ranked
 * facts so that facts relevant to the current user message surface even if their
 * stored importance is low.
 */
export async function recallFacts(input: {
  projectId: ProjectID
  scopePrefix?: string
  limit?: number
  context?: string // optional: user message text for contextual keyword boost
}): Promise<KnowledgeEntry[]> {
  const db = zengramDb()
  const scope = input.scopePrefix ?? "/"
  const limit = Math.min(input.limit ?? 20, 100)
  const now = Date.now() * 1000

  if (input.context) {
    // Extract significant keywords (>= 4 chars, not stopwords) from the context.
    const words = input.context
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
    const keywords = [...new Set(words)].slice(0, 8)

    if (keywords.length > 0) {
      // Fetch importance-ranked baseline + keyword matches, deduplicate by id.
      const baseline = await db.query<KnowledgeEntry>(
        `SELECT id, scope, subject, content, importance, source_session
         FROM knowledge
         WHERE project_id = $1
           AND scope LIKE $2
           AND status = 'active'
           AND (valid_to IS NULL OR valid_to > $3)
         ORDER BY importance DESC, access_count DESC
         LIMIT ${Math.ceil(limit * 0.6)}`,
        [input.projectId, `${scope}%`, now],
      )

      // Build OR conditions for each keyword
      const whereParts = keywords.map((_, i) => `(subject ILIKE $${i + 4} OR content ILIKE $${i + 4})`).join(" OR ")
      const contextMatches = await db.query<KnowledgeEntry>(
        `SELECT id, scope, subject, content, importance, source_session
         FROM knowledge
         WHERE project_id = $1
           AND scope LIKE $2
           AND status = 'active'
           AND (valid_to IS NULL OR valid_to > $3)
           AND (${whereParts})
         ORDER BY importance DESC
         LIMIT ${Math.ceil(limit * 0.6)}`,
        [input.projectId, `${scope}%`, now, ...keywords.map((k) => `%${k}%`)],
      )
      // Merge: context matches first (higher relevance), then baseline, deduplicated.
      const seen = new Set<string>()
      const merged: KnowledgeEntry[] = []
      for (const row of [...contextMatches, ...baseline]) {
        if (!seen.has(row.id)) {
          seen.add(row.id)
          merged.push(row)
        }
        if (merged.length >= limit) break
      }
      return merged
    }
  }

  const rows = await db.query<KnowledgeEntry>(
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
  return rows
}

const STOP_WORDS = new Set([
  "that", "this", "with", "have", "from", "they", "will", "been", "when",
  "your", "what", "about", "which", "there", "their", "would", "could",
  "should", "does", "into", "also", "some", "than", "then", "make",
  "just", "like", "more", "over", "such", "each", "were", "being",
])

/**
 * Full-text keyword search over active knowledge.
 * Matches against subject and content using ILIKE (case-insensitive substring).
 * Returns up to `limit` entries ordered by importance DESC.
 */
export async function searchFacts(input: {
  projectId: ProjectID
  query: string
  limit?: number
}): Promise<KnowledgeEntry[]> {
  const db = zengramDb()
  const limit = Math.min(input.limit ?? 20, 100)
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
    [input.projectId, Date.now() * 1000, pattern],
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

  // Gather text from all text-type parts for this turn
  const parts = await db.query<{ data: any }>(
    `SELECT data FROM part WHERE turn_id = $1 AND type = 'text' ORDER BY position ASC`,
    [input.turnId],
  )
  const fullText = parts
    .map((p) => (typeof p.data === "string" ? p.data : (p.data as any)?.text ?? ""))
    .join("\n")
    .trim()

  if (fullText.length < 100) return 0 // Too short to extract from

  const facts = extractFacts(fullText)
  log.info("passive extraction", { turnId: input.turnId, textLen: fullText.length, candidates: facts.length })
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
  return stored
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
 * Format recalled knowledge as a system-prompt block.
 * Returns null if there's nothing to inject.
 */
export function formatKnowledgeBlock(facts: KnowledgeEntry[]): string | null {
  if (facts.length === 0) return null
  const lines = facts.map((f) => `- **${f.subject}**: ${f.content}`)
  return `<zengram-knowledge>\nThe following facts were recalled from persistent memory:\n${lines.join("\n")}\n</zengram-knowledge>`
}

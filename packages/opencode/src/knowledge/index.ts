/**
 * Knowledge store helpers for OpenCode + Zengram.
 *
 * Provides write (learn) and read (recall) access to the Zengram `knowledge`
 * table. Only active when OPENCODE_STORAGE=zengram.
 */

import { zengramDb } from "@/storage/db.zengram"
import { ulid } from "ulid"
import type { ProjectID } from "@/project/schema"
import type { SessionID, MessageID } from "@/session/schema"

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
 * Fetch active knowledge for a project, optionally filtered by scope prefix.
 * Returns entries ordered by importance desc, capped at `limit`.
 */
export async function recallFacts(input: {
  projectId: ProjectID
  scopePrefix?: string
  limit?: number
}): Promise<KnowledgeEntry[]> {
  const db = zengramDb()
  const scope = input.scopePrefix ?? "/"
  const limit = Math.min(input.limit ?? 20, 100)

  const rows = await db.query<KnowledgeEntry>(
    `SELECT id, scope, subject, content, importance, source_session
     FROM knowledge
     WHERE project_id = $1
       AND scope LIKE $2
       AND status = 'active'
       AND (valid_to IS NULL OR valid_to > $3)
     ORDER BY importance DESC, access_count DESC
     LIMIT ${limit}`,
    [input.projectId, `${scope}%`, Date.now() * 1000],
  )
  return rows
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

/**
 * Zengram read helpers for the session module.
 * Used by session/index.ts and server/projectors.ts when OPENCODE_STORAGE=zengram.
 */

import type { Session } from "./index"
import { zengramDb } from "@/storage/db.zengram"
import type { SessionID } from "./schema"
import type { ProjectID } from "../project/schema"

/** Map a Zengram session row to a Session.Info object. */
export function zengramRowToSessionInfo(row: Record<string, any>): Session.Info {
  const summary =
    row.summary_additions != null || row.summary_deletions != null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory ?? "",
    parentID: row.parent_id ?? undefined,
    title: row.title,
    version: row.version ?? "",
    summary,
    share: row.share_url ? { url: row.share_url } : undefined,
    revert: row.revert_state ?? undefined,
    permission: row.permission_json ? JSON.parse(row.permission_json) : undefined,
    time: {
      created: typeof row.time_created === "bigint" ? Number(row.time_created) / 1000 : row.time_created,
      updated: typeof row.time_updated === "bigint" ? Number(row.time_updated) / 1000 : row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

const SESSION_COLS = `
  id, project_id, parent_id, title, slug, workspace_id, directory, version,
  share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
  revert_state, permission_json, time_created, time_updated, time_compacting, time_archived
`

/** Get a session by ID from Zengram. Returns null if not found. */
export async function zengramGetSession(id: SessionID): Promise<Session.Info | null> {
  const db = zengramDb()
  const rows = await db.query<Record<string, any>>(
    `SELECT ${SESSION_COLS} FROM session WHERE id = $1`,
    [id],
  )
  if (!rows[0]) return null
  return zengramRowToSessionInfo(rows[0])
}

/** Get child sessions (sub-agent sessions) from Zengram. */
export async function zengramGetChildren(
  projectId: ProjectID,
  parentId: SessionID,
): Promise<Session.Info[]> {
  const db = zengramDb()
  const rows = await db.query<Record<string, any>>(
    `SELECT ${SESSION_COLS} FROM session
     WHERE project_id = $1 AND parent_id = $2
     ORDER BY time_created ASC`,
    [projectId, parentId],
  )
  return rows.map(zengramRowToSessionInfo)
}

/** List sessions for a project with optional filters. */
export async function zengramListSessions(opts: {
  projectId: ProjectID
  workspaceId?: string
  directory?: string
  excludeChildren?: boolean
  since?: number
  before?: number
  search?: string
  includeArchived?: boolean
  limit?: number
}): Promise<Session.Info[]> {
  const db = zengramDb()
  const conditions: string[] = ["project_id = $1"]
  const params: unknown[] = [opts.projectId]
  let idx = 2

  if (opts.workspaceId) {
    conditions.push(`workspace_id = $${idx++}`)
    params.push(opts.workspaceId)
  }
  if (opts.directory) {
    conditions.push(`directory = $${idx++}`)
    params.push(opts.directory)
  }
  if (opts.excludeChildren) {
    conditions.push(`parent_id IS NULL`)
  }
  if (opts.since !== undefined) {
    conditions.push(`time_updated >= $${idx++}`)
    params.push(opts.since * 1000)
  }
  if (opts.before !== undefined) {
    conditions.push(`time_updated < $${idx++}`)
    params.push(opts.before * 1000)
  }
  if (opts.search) {
    conditions.push(`title LIKE $${idx++}`)
    params.push(`%${opts.search}%`)
  }
  if (!opts.includeArchived) {
    conditions.push(`time_archived IS NULL`)
  }

  const limit = opts.limit ?? 50
  params.push(limit)

  const rows = await db.query<Record<string, any>>(
    `SELECT ${SESSION_COLS} FROM session
     WHERE ${conditions.join(" AND ")}
     ORDER BY time_updated DESC, id DESC
     LIMIT $${idx}`,
    params,
  )
  return rows.map(zengramRowToSessionInfo)
}

/** Get summary info (id, title, worktree) for sessions' projects. */
export async function zengramGetProjectSummaries(
  projectIds: string[],
): Promise<Array<{ id: string; name: string | null; worktree: string }>> {
  if (projectIds.length === 0) return []
  const db = zengramDb()
  // Build parameterized IN clause
  const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(", ")
  return db.query<{ id: string; name: string | null; worktree: string }>(
    `SELECT id, name, worktree FROM project WHERE id IN (${placeholders})`,
    projectIds,
  )
}

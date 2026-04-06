/**
 * Session projectors for the Zengram storage backend.
 *
 * These replace the SQLite/Drizzle projectors when OPENCODE_STORAGE=zengram.
 * Each projector maps an OpenCode event to one or more Zengram SQL writes.
 *
 * Data model mapping:
 *   OpenCode message  → Zengram turn  (key fields unpacked to columns)
 *   OpenCode part     → Zengram part  (data JSONB, type extracted)
 *   tool part         → also creates a tool_call row
 *   OpenCode session  → Zengram session (with V007 OpenCode-extension columns)
 */

import { SyncEvent } from "@/sync"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { zengramDb } from "@/storage/db.zengram"
import { Log } from "../util/log"
import { randomUUID } from "node:crypto"
import { extractAndLearn } from "@/knowledge"
import { Instance } from "@/project/instance"

const log = Log.create({ service: "session.projector.zengram" })

// ── Session ───────────────────────────────────────────────────────────────────

export default [
  SyncEvent.project(Session.Event.Created, async (data) => {
    const info = data.info
    const db = zengramDb()
    const now = Date.now() * 1000
    const branchId = randomUUID()

    // Insert session with OpenCode-specific fields (V007 extension columns)
    await db.execute(
      `INSERT INTO session
         (id, project_id, parent_id, title, slug, agent, workspace_id, directory, version,
          permission_json, status, active_branch, time_created, time_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [
        info.id, info.projectID, info.parentID ?? null,
        info.title, info.slug, null,
        info.workspaceID ?? null, info.directory, info.version ?? null,
        info.permission ? JSON.stringify(info.permission) : null,
        branchId, now, now,
      ],
    )

    // Create the trunk branch
    await db.execute(
      `INSERT INTO branch (id, session_id, name, status, time_created, time_updated)
       VALUES ($1,$2,'trunk','active',$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [branchId, info.id, now, now],
    )

    log.info("created session in Zengram", { sessionID: info.id })
  }),

  SyncEvent.project(Session.Event.Updated, async (data) => {
    const info = data.info
    const db = zengramDb()
    const now = Date.now() * 1000

    // Build a partial update using only the fields present in info
    const fields: string[] = ["time_updated = $1"]
    const params: unknown[] = [now]
    let idx = 2

    if ("title" in info && info.title !== undefined) {
      fields.push(`title = $${idx++}`)
      params.push(info.title)
    }
    if ("workspaceID" in info && info.workspaceID !== undefined) {
      fields.push(`workspace_id = $${idx++}`)
      params.push(info.workspaceID ?? null)
    }
    if ("directory" in info && info.directory !== undefined) {
      fields.push(`directory = $${idx++}`)
      params.push(info.directory)
    }
    if ("share" in info && info.share !== undefined) {
      fields.push(`share_url = $${idx++}`)
      params.push(info.share ? (info.share as any).url ?? null : null)
    }
    if ("summary" in info && info.summary !== undefined) {
      const s = info.summary as any
      if (s !== null) {
        fields.push(`summary_additions = $${idx++}`, `summary_deletions = $${idx++}`, `summary_files = $${idx++}`)
        params.push(s.additions ?? 0, s.deletions ?? 0, s.files ?? 0)
        fields.push(`summary_diffs = $${idx++}`)
        params.push(s.diffs ? JSON.stringify(s.diffs) : null)
      }
    }
    if ("permission" in info && info.permission !== undefined) {
      fields.push(`permission_json = $${idx++}`)
      params.push(info.permission ? JSON.stringify(info.permission) : null)
    }
    if ("time" in info && (info.time as any)?.compacting !== undefined) {
      fields.push(`time_compacting = $${idx++}`)
      params.push((info.time as any).compacting ?? null)
    }
    if ("time" in info && (info.time as any)?.archived !== undefined) {
      fields.push(`time_archived = $${idx++}`)
      params.push((info.time as any).archived ?? null)
    }

    params.push(data.sessionID)
    await db.execute(
      `UPDATE session SET ${fields.join(", ")} WHERE id = $${idx}`,
      params,
    )
  }),

  SyncEvent.project(Session.Event.Deleted, async (data) => {
    const db = zengramDb()
    await db.execute(`DELETE FROM session WHERE id = $1`, [data.sessionID])
  }),

  // ── Messages (turns) ───────────────────────────────────────────────────────

  SyncEvent.project(MessageV2.Event.Updated, async (data) => {
    const info = data.info
    const db = zengramDb()
    const now = Date.now() * 1000

    // Fetch the session's active_branch to use as branch_id
    const rows = await db.query<{ active_branch: string }>(
      `SELECT active_branch FROM session WHERE id = $1`,
      [info.sessionID],
    )
    const branchId = rows[0]?.active_branch
    if (!branchId) {
      log.warn("session not found for message; skipping", { sessionID: info.sessionID, messageID: info.id })
      return
    }

    // Map MessageV2.Info fields to turn columns
    const role = (info as any).role ?? "user"
    const agent = (info as any).agent ?? null
    // Assistant has flat modelID/providerID; User has model: { modelID, providerID }
    const modelId = (info as any).modelID ?? (info as any).model?.modelID ?? null
    const providerId = (info as any).providerID ?? (info as any).model?.providerID ?? null
    const tokensInput = (info as any).tokens?.input ?? 0
    const tokensOutput = (info as any).tokens?.output ?? 0
    const tokensReasoning = (info as any).tokens?.reasoning ?? 0
    const tokensCacheRead = (info as any).tokens?.cache?.read ?? 0
    const tokensCacheWrite = (info as any).tokens?.cache?.write ?? 0
    const costUsd = (info as any).cost ?? 0
    const finishReason = (info as any).finish ?? null
    const timeCompleted = (info as any).time?.completed ?? null

    await db.execute(
      `INSERT INTO turn
         (id, session_id, branch_id, role, agent, model_id, provider_id,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          cost_usd, finish_reason, status, tier, time_created, time_completed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active','hot',$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         role = EXCLUDED.role, agent = EXCLUDED.agent,
         model_id = EXCLUDED.model_id, provider_id = EXCLUDED.provider_id,
         tokens_input = EXCLUDED.tokens_input, tokens_output = EXCLUDED.tokens_output,
         tokens_reasoning = EXCLUDED.tokens_reasoning,
         tokens_cache_read = EXCLUDED.tokens_cache_read, tokens_cache_write = EXCLUDED.tokens_cache_write,
         cost_usd = EXCLUDED.cost_usd, finish_reason = EXCLUDED.finish_reason,
         time_completed = EXCLUDED.time_completed`,
      [
        info.id, info.sessionID, branchId, role, agent, modelId, providerId,
        tokensInput, tokensOutput, tokensReasoning, tokensCacheRead, tokensCacheWrite,
        costUsd, finishReason,
        info.time.created * 1000, // microseconds
        timeCompleted ? timeCompleted * 1000 : null,
      ],
    )

    // Passive extraction: when an assistant turn completes, scan for durable facts.
    // Fire-and-forget — never blocks the main event path.
    if (role === "assistant" && finishReason) {
      extractAndLearn({
        projectId: Instance.project.id,
        sessionId: info.sessionID,
        turnId: info.id,
      }).catch((err) => log.warn("passive extraction failed", { err }))
    }
  }),

  SyncEvent.project(MessageV2.Event.Removed, async (data) => {
    const db = zengramDb()
    await db.execute(
      `DELETE FROM turn WHERE id = $1 AND session_id = $2`,
      [data.messageID, data.sessionID],
    )
  }),

  // ── Parts ──────────────────────────────────────────────────────────────────

  SyncEvent.project(MessageV2.Event.PartUpdated, async (data) => {
    const part = data.part
    const db = zengramDb()
    const now = data.time * 1000 // microseconds

    const { id, messageID, sessionID, ...restData } = part
    const partType = (restData as any).type ?? "unknown"

    // Compute position from existing parts count (approximate — ordering by id is stable)
    const countRows = await db.query<{ n: number }>(
      `SELECT COUNT(*) as n FROM part WHERE turn_id = $1`,
      [messageID],
    )
    const position = countRows[0]?.n ?? 0

    const dataWithoutId = { ...restData }

    await db.execute(
      `INSERT INTO part (id, turn_id, session_id, type, data, position, time_created, time_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type, data = EXCLUDED.data, time_updated = EXCLUDED.time_updated`,
      [id, messageID, sessionID, partType, dataWithoutId, position, now, now],
    )

    // For tool parts, also maintain the tool_call table
    if (partType === "tool") {
      const toolData = restData as any
      const state = toolData.state ?? "pending"
      const toolState = state === "completed" ? "completed" : state === "error" ? "error" : state === "running" ? "running" : "pending"

      await db.execute(
        `INSERT INTO tool_call
           (id, turn_id, part_id, session_id, tool_id, state, input, output, error,
            duration_ms, tokens_consumed, time_created, time_completed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET
           state = EXCLUDED.state, output = EXCLUDED.output, error = EXCLUDED.error,
           duration_ms = EXCLUDED.duration_ms, tokens_consumed = EXCLUDED.tokens_consumed,
           time_completed = EXCLUDED.time_completed`,
        [
          id, messageID, id, sessionID,
          toolData.toolName ?? "unknown",
          toolState,
          toolData.input ?? {},
          toolData.output ?? null,
          toolData.error ?? null,
          toolData.time ? Math.round((toolData.time.end ?? toolData.time.start) - toolData.time.start) : null,
          0, // tokens_consumed
          now,
          toolState === "completed" || toolState === "error" ? now : null,
        ],
      )
    }
  }),

  SyncEvent.project(MessageV2.Event.PartRemoved, async (data) => {
    const db = zengramDb()
    await db.execute(
      `DELETE FROM part WHERE id = $1 AND session_id = $2`,
      [data.partID, data.sessionID],
    )
    // tool_call is deleted via cascade (or explicit delete)
    await db.execute(
      `DELETE FROM tool_call WHERE id = $1 AND session_id = $2`,
      [data.partID, data.sessionID],
    )
  }),
]

import type { Argv } from "yargs"
import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { zengramDb } from "../../storage/db.zengram"
import { Instance } from "../../project/instance"
import { ShareNext } from "../../share/share-next"
import { EOL } from "os"
import { Filesystem } from "../../util/filesystem"
import { randomUUID } from "node:crypto"

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      let exportData:
        | {
            info: SDKSession
            messages: Array<{
              info: Message
              parts: Part[]
            }>
          }
        | undefined

      const isUrl = args.file.startsWith("http://") || args.file.startsWith("https://")

      if (isUrl) {
        const slug = parseShareUrl(args.file)
        if (!slug) {
          const baseUrl = await ShareNext.url()
          process.stdout.write(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
          process.stdout.write(EOL)
          return
        }

        const parsed = new URL(args.file)
        const baseUrl = parsed.origin
        const req = await ShareNext.request()
        const headers = shouldAttachShareAuthHeaders(args.file, req.baseUrl) ? req.headers : {}

        const dataPath = req.api.data(slug)
        let response = await fetch(`${baseUrl}${dataPath}`, {
          headers,
        })

        if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
          response = await fetch(`${baseUrl}/api/share/${slug}/data`, {
            headers,
          })
        }

        if (!response.ok) {
          process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
          process.stdout.write(EOL)
          return
        }

        const shareData: ShareData[] = await response.json()
        const transformed = transformShareData(shareData)

        if (!transformed) {
          process.stdout.write(`Share not found or empty: ${slug}`)
          process.stdout.write(EOL)
          return
        }

        exportData = transformed
      } else {
        exportData = await Filesystem.readJson<NonNullable<typeof exportData>>(args.file).catch(() => undefined)
        if (!exportData) {
          process.stdout.write(`File not found: ${args.file}`)
          process.stdout.write(EOL)
          return
        }
      }

      if (!exportData) {
        process.stdout.write(`Failed to read session data`)
        process.stdout.write(EOL)
        return
      }

      const info = Session.Info.parse({
        ...exportData.info,
        projectID: Instance.project.id,
      })
      const db = zengramDb()
      const now = Date.now() * 1000
      const branchId = randomUUID()

      await db.execute(
        `INSERT INTO session
           (id, project_id, parent_id, title, slug, workspace_id, directory, version,
            permission_json, status, active_branch, time_created, time_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET project_id = EXCLUDED.project_id`,
        [
          info.id,
          info.projectID,
          info.parentID ?? null,
          info.title,
          info.slug,
          info.workspaceID ?? null,
          info.directory,
          info.version ?? null,
          info.permission ? JSON.stringify(info.permission) : null,
          branchId,
          (info.time.created ?? Date.now()) * 1000,
          (info.time.updated ?? Date.now()) * 1000,
        ],
      )

      await db.execute(
        `INSERT INTO branch (id, session_id, name, status, time_created, time_updated)
         VALUES ($1,$2,'trunk','active',$3,$4)
         ON CONFLICT (id) DO NOTHING`,
        [branchId, info.id, now, now],
      )

      for (const msg of exportData.messages) {
        const msgInfo = MessageV2.Info.parse(msg.info)
        const role = (msgInfo as any).role ?? "user"
        const agent = (msgInfo as any).agent ?? null
        const modelId = (msgInfo as any).modelID ?? (msgInfo as any).model?.modelID ?? null
        const providerId = (msgInfo as any).providerID ?? (msgInfo as any).model?.providerID ?? null
        const tokens = (msgInfo as any).tokens ?? {}
        const timeCreated = (msgInfo.time?.created ?? Date.now()) * 1000
        const timeCompleted = (msgInfo as any).time?.completed
          ? (msgInfo as any).time.completed * 1000
          : null

        await db.execute(
          `INSERT INTO turn
             (id, session_id, branch_id, role, agent, model_id, provider_id,
              tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
              cost_usd, finish_reason, status, tier, time_created, time_completed)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active','hot',$15,$16)
           ON CONFLICT (id) DO NOTHING`,
          [
            msgInfo.id,
            info.id,
            branchId,
            role,
            agent,
            modelId,
            providerId,
            tokens.input ?? 0,
            tokens.output ?? 0,
            tokens.reasoning ?? 0,
            tokens.cache?.read ?? 0,
            tokens.cache?.write ?? 0,
            (msgInfo as any).cost ?? 0,
            (msgInfo as any).finish ?? null,
            timeCreated,
            timeCompleted,
          ],
        )

        let position = 0
        for (const part of msg.parts) {
          const partInfo = MessageV2.Part.parse(part)
          const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
          await db.execute(
            `INSERT INTO part (id, turn_id, session_id, type, data, position, time_created, time_updated)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (id) DO NOTHING`,
            [partId, messageID, info.id, partInfo.type, partData, position++, timeCreated, timeCreated],
          )
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})

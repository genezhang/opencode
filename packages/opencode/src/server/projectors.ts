import z from "zod"
import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"
import { ZENGRAM_ENABLED } from "@/storage/db.zengram"
import { zengramGetSession } from "@/session/zengram"

export function initProjectors() {
  // Route projectors to the right map based on storage mode
  const initOpts: Parameters<typeof SyncEvent.init>[0] = ZENGRAM_ENABLED
    ? { asyncProjectors: sessionProjectors as any }
    : { syncProjectors: sessionProjectors as any }

  SyncEvent.init({
    ...initOpts,
    convertEvent: async (type, data) => {
      if (type === "session.updated") {
        const id = (data as z.infer<typeof Session.Event.Updated.schema>).sessionID

        if (ZENGRAM_ENABLED) {
          const info = await zengramGetSession(id as any)
          if (!info) return data
          return { sessionID: id, info }
        }

        // SQLite path
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
        if (!row) return data
        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      return data
    },
  })
}


initProjectors()

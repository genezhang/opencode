import z from "zod"
import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session"
import { zengramGetSession } from "@/session/zengram"

export function initProjectors() {
  SyncEvent.init({
    asyncProjectors: sessionProjectors as any,
    convertEvent: async (type, data) => {
      if (type === "session.updated") {
        const id = (data as z.infer<typeof Session.Event.Updated.schema>).sessionID
        const info = await zengramGetSession(id as any)
        if (!info) return data
        return { sessionID: id, info }
      }
      return data
    },
  })
}


initProjectors()

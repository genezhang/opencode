import z from "zod"
import { setTimeout as sleep } from "node:timers/promises"
import { fn } from "@/util/fn"
import { Project } from "@/project/project"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util/log"
import { ProjectID } from "@/project/schema"
import { getAdaptor } from "./adaptors"
import { WorkspaceInfo } from "./types"
import { WorkspaceID } from "./schema"
import { parseSSE } from "./sse"
import { zengramDb } from "@/storage/db.zengram"

export namespace Workspace {
  export const Event = {
    Ready: BusEvent.define(
      "workspace.ready",
      z.object({
        name: z.string(),
      }),
    ),
    Failed: BusEvent.define(
      "workspace.failed",
      z.object({
        message: z.string(),
      }),
    ),
  }

  export const Info = WorkspaceInfo.meta({
    ref: "Workspace",
  })
  export type Info = z.infer<typeof Info>

  const CreateInput = z.object({
    id: WorkspaceID.zod.optional(),
    type: Info.shape.type,
    branch: Info.shape.branch,
    projectID: ProjectID.zod,
    extra: Info.shape.extra,
  })

  export const create = fn(CreateInput, async (input) => {
    const id = WorkspaceID.ascending(input.id)
    const adaptor = await getAdaptor(input.type)

    const config = await adaptor.configure({ ...input, id, name: null, directory: null })

    const info: Info = {
      id,
      type: config.type,
      branch: config.branch ?? null,
      name: config.name ?? null,
      directory: config.directory ?? null,
      extra: config.extra ?? null,
      projectID: input.projectID,
    }

    const now = Date.now() * 1000
    await zengramDb().execute(
      `INSERT INTO workspace (id, project_id, type, branch, name, directory, extra, time_created, time_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        info.id, info.projectID, info.type, info.branch ?? null, info.name ?? null,
        info.directory ?? null, info.extra ? JSON.stringify(info.extra) : null, now, now,
      ],
    )

    await adaptor.create(config)
    return info
  })

  export async function list(project: Project.Info): Promise<Info[]> {
    const rows = await zengramDb().query<{
      id: string; project_id: string; type: string; branch: string | null
      name: string | null; directory: string | null; extra: unknown
    }>(
      `SELECT id, project_id, type, branch, name, directory, extra FROM workspace WHERE project_id = $1`,
      [project.id],
    )
    return rows
      .map((row) => ({
        id: row.id as WorkspaceID & string,
        type: row.type as Info["type"],
        branch: row.branch ?? null,
        name: row.name ?? null,
        directory: row.directory ?? null,
        extra: row.extra as Info["extra"],
        projectID: row.project_id as ProjectID & string,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  export const get = fn(WorkspaceID.zod, async (id) => {
    const rows = await zengramDb().query<{
      id: string; project_id: string; type: string; branch: string | null
      name: string | null; directory: string | null; extra: unknown
    }>(
      `SELECT id, project_id, type, branch, name, directory, extra FROM workspace WHERE id = $1`,
      [id],
    )
    if (!rows[0]) return undefined
    const row = rows[0]
    return {
      id: row.id as WorkspaceID & string,
      type: row.type as Info["type"],
      branch: row.branch ?? null,
      name: row.name ?? null,
      directory: row.directory ?? null,
      extra: row.extra as Info["extra"],
      projectID: row.project_id as ProjectID & string,
    }
  })

  export const remove = fn(WorkspaceID.zod, async (id) => {
    const rows = await zengramDb().query<{
      id: string; project_id: string; type: string; branch: string | null
      name: string | null; directory: string | null; extra: unknown
    }>(
      `SELECT id, project_id, type, branch, name, directory, extra FROM workspace WHERE id = $1`,
      [id],
    )
    if (!rows[0]) return undefined
    const row = rows[0]
    const info: Info = {
      id: row.id as WorkspaceID & string,
      type: row.type as Info["type"],
      branch: row.branch ?? null,
      name: row.name ?? null,
      directory: row.directory ?? null,
      extra: row.extra as Info["extra"],
      projectID: row.project_id as ProjectID & string,
    }
    const adaptor = await getAdaptor(row.type)
    adaptor.remove(info)
    await zengramDb().execute(`DELETE FROM workspace WHERE id = $1`, [id])
    return info
  })
  const log = Log.create({ service: "workspace-sync" })

  async function workspaceEventLoop(space: Info, stop: AbortSignal) {
    while (!stop.aborted) {
      const adaptor = await getAdaptor(space.type)
      const res = await adaptor.fetch(space, "/event", { method: "GET", signal: stop }).catch(() => undefined)
      if (!res || !res.ok || !res.body) {
        await sleep(1000)
        continue
      }
      await parseSSE(res.body, stop, (event) => {
        GlobalBus.emit("event", {
          directory: space.id,
          payload: event,
        })
      })
      // Wait 250ms and retry if SSE connection fails
      await sleep(250)
    }
  }

  export function startSyncing(project: Project.Info) {
    const stop = new AbortController()
    void list(project).then((spaces) => {
      spaces.filter((space) => space.type !== "worktree").forEach((space) => {
        void workspaceEventLoop(space, stop.signal).catch((error) => {
          log.warn("workspace sync listener failed", {
            workspaceID: space.id,
            error,
          })
        })
      })
    })

    return {
      async stop() {
        stop.abort()
      },
    }
  }
}

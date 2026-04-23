import z from "zod"
import { Log } from "../util/log"
import { Flag } from "@/flag/flag"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { which } from "../util/which"
import { ProjectID } from "./schema"
import { Effect, Layer, Path, Scope, ServiceMap, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { makeRuntime } from "@/effect/run-service"
import { AppFileSystem } from "@/filesystem"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { zengramDb } from "@/storage/db.zengram"

export namespace Project {
  const log = Log.create({ service: "project" })

  export const Info = z
    .object({
      id: ProjectID.zod,
      worktree: z.string(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  type ZengramProjectRow = {
    id: string
    name: string | null
    worktree: string
    vcs: string | null
    icon_url: string | null
    icon_color: string | null
    sandboxes: string[] | null
    commands: { start?: string } | null
    time_created: number | string
    time_updated: number | string
    time_initialized: number | string | null
  }

  function zengramRowToProjectInfo(row: ZengramProjectRow): Info {
    const icon =
      row.icon_url || row.icon_color
        ? { url: row.icon_url ?? undefined, color: row.icon_color ?? undefined }
        : undefined
    return {
      id: row.id as ProjectID,
      worktree: row.worktree,
      vcs: row.vcs ? Info.shape.vcs.parse(row.vcs) : undefined,
      name: row.name ?? undefined,
      icon,
      time: {
        created: Number(row.time_created),
        updated: Number(row.time_updated),
        initialized: row.time_initialized != null ? Number(row.time_initialized) : undefined,
      },
      sandboxes: row.sandboxes ?? [],
      commands: row.commands ?? undefined,
    }
  }

  export const UpdateInput = z.object({
    projectID: ProjectID.zod,
    name: z.string().optional(),
    icon: Info.shape.icon.optional(),
    commands: Info.shape.commands.optional(),
  })
  export type UpdateInput = z.infer<typeof UpdateInput>

  // ---------------------------------------------------------------------------
  // Effect service
  // ---------------------------------------------------------------------------

  export interface Interface {
    readonly fromDirectory: (directory: string) => Effect.Effect<{ project: Info; sandbox: string }>
    readonly discover: (input: Info) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Info[]>
    readonly get: (id: ProjectID) => Effect.Effect<Info | undefined>
    readonly update: (input: UpdateInput) => Effect.Effect<Info>
    readonly initGit: (input: { directory: string; project: Info }) => Effect.Effect<Info>
    readonly setInitialized: (id: ProjectID) => Effect.Effect<void>
    readonly sandboxes: (id: ProjectID) => Effect.Effect<string[]>
    readonly addSandbox: (id: ProjectID, directory: string) => Effect.Effect<void>
    readonly removeSandbox: (id: ProjectID, directory: string) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Project") {}

  type GitResult = { code: number; text: string; stderr: string }

  export const layer: Layer.Layer<
    Service,
    never,
    AppFileSystem.Service | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const pathSvc = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const git = Effect.fnUntraced(
        function* (args: string[], opts?: { cwd?: string }) {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const [text, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, text, stderr } satisfies GitResult
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed({ code: 1, text: "", stderr: "" } satisfies GitResult)),
      )

      const emitUpdated = (data: Info) =>
        Effect.sync(() =>
          GlobalBus.emit("event", {
            payload: { type: Event.Updated.type, properties: data },
          }),
        )

      const fakeVcs = Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS)

      const resolveGitPath = (cwd: string, name: string) => {
        if (!name) return cwd
        name = name.replace(/[\r\n]+$/, "")
        if (!name) return cwd
        name = AppFileSystem.windowsPath(name)
        if (pathSvc.isAbsolute(name)) return pathSvc.normalize(name)
        return pathSvc.resolve(cwd, name)
      }

      const scope = yield* Scope.Scope

      const readCachedProjectId = Effect.fnUntraced(function* (dir: string) {
        return yield* fs.readFileString(pathSvc.join(dir, "opencode")).pipe(
          Effect.map((x) => x.trim()),
          Effect.map(ProjectID.make),
          Effect.catch(() => Effect.succeed(undefined)),
        )
      })

      const fromDirectory = Effect.fn("Project.fromDirectory")(function* (directory: string) {
        log.info("fromDirectory", { directory })

        // Phase 1: discover git info
        type DiscoveryResult = { id: ProjectID; worktree: string; sandbox: string; vcs: Info["vcs"] }

        const data: DiscoveryResult = yield* Effect.gen(function* () {
          const dotgitMatches = yield* fs.up({ targets: [".git"], start: directory }).pipe(Effect.orDie)
          const dotgit = dotgitMatches[0]

          if (!dotgit) {
            return {
              id: ProjectID.global,
              worktree: "/",
              sandbox: "/",
              vcs: fakeVcs,
            }
          }

          let sandbox = pathSvc.dirname(dotgit)
          const gitBinary = yield* Effect.sync(() => which("git"))
          let id = yield* readCachedProjectId(dotgit)

          if (!gitBinary) {
            return {
              id: id ?? ProjectID.global,
              worktree: sandbox,
              sandbox,
              vcs: fakeVcs,
            }
          }

          const commonDir = yield* git(["rev-parse", "--git-common-dir"], { cwd: sandbox })
          if (commonDir.code !== 0) {
            return {
              id: id ?? ProjectID.global,
              worktree: sandbox,
              sandbox,
              vcs: fakeVcs,
            }
          }
          const worktree = (() => {
            const common = resolveGitPath(sandbox, commonDir.text.trim())
            return common === sandbox ? sandbox : pathSvc.dirname(common)
          })()

          if (id == null) {
            id = yield* readCachedProjectId(pathSvc.join(worktree, ".git"))
          }

          if (!id) {
            const revList = yield* git(["rev-list", "--max-parents=0", "HEAD"], { cwd: sandbox })
            const roots = revList.text
              .split("\n")
              .filter(Boolean)
              .map((x) => x.trim())
              .toSorted()

            id = roots[0] ? ProjectID.make(roots[0]) : undefined
            if (id) {
              yield* fs.writeFileString(pathSvc.join(worktree, ".git", "opencode"), id).pipe(Effect.ignore)
            }
          }

          if (!id) {
            return { id: ProjectID.global, worktree: sandbox, sandbox, vcs: "git" as const }
          }

          const topLevel = yield* git(["rev-parse", "--show-toplevel"], { cwd: sandbox })
          if (topLevel.code !== 0) {
            return {
              id,
              worktree: sandbox,
              sandbox,
              vcs: fakeVcs,
            }
          }
          sandbox = resolveGitPath(sandbox, topLevel.text.trim())

          return { id, sandbox, worktree, vcs: "git" as const }
        })

        // Phase 2: upsert
        const existing: Info = yield* Effect.promise(async () => {
          const rows = await zengramDb().query<ZengramProjectRow>(
            `SELECT id, name, worktree, vcs, icon_url, icon_color, sandboxes, commands,
                    time_created, time_updated, time_initialized
             FROM project WHERE id = $1`,
            [data.id],
          )
          if (rows[0]) return zengramRowToProjectInfo(rows[0])
          return {
            id: data.id,
            worktree: data.worktree,
            vcs: data.vcs,
            sandboxes: [] as string[],
            time: { created: Date.now(), updated: Date.now() },
          } as Info
        })

        if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY)
          yield* discover(existing).pipe(Effect.ignore, Effect.forkIn(scope))

        const result: Info = {
          ...existing,
          worktree: data.worktree,
          vcs: data.vcs,
          time: { ...existing.time, updated: Date.now() },
        }
        if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
          result.sandboxes.push(data.sandbox)
        result.sandboxes = yield* Effect.forEach(
          result.sandboxes,
          (s) =>
            fs.exists(s).pipe(
              Effect.orDie,
              Effect.map((exists) => (exists ? s : undefined)),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))

        yield* Effect.promise(async () => {
          const zdb = zengramDb()
          await zdb.execute(
            `INSERT INTO project (id, name, root_path, worktree, vcs, icon_url, icon_color,
                    sandboxes, commands, time_created, time_updated, time_initialized)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name, root_path = EXCLUDED.root_path,
               worktree = EXCLUDED.worktree, vcs = EXCLUDED.vcs,
               icon_url = EXCLUDED.icon_url, icon_color = EXCLUDED.icon_color,
               time_updated = EXCLUDED.time_updated,
               time_initialized = EXCLUDED.time_initialized,
               sandboxes = EXCLUDED.sandboxes, commands = EXCLUDED.commands`,
            [
              result.id, result.name ?? null, result.worktree, result.worktree,
              result.vcs ?? null, result.icon?.url ?? null, result.icon?.color ?? null,
              JSON.stringify(result.sandboxes),
              result.commands ? JSON.stringify(result.commands) : null,
              result.time.created, result.time.updated, result.time.initialized ?? null,
            ],
          )
          if (data.id !== ProjectID.global) {
            await zdb.execute(
              `UPDATE session SET project_id = $1 WHERE project_id = $2 AND directory = $3`,
              [data.id, ProjectID.global, data.worktree],
            )
          }
        })

        yield* emitUpdated(result)
        return { project: result, sandbox: data.sandbox }
      })

      const discover = Effect.fn("Project.discover")(function* (input: Info) {
        if (input.vcs !== "git") return
        if (input.icon?.override) return
        if (input.icon?.url) return

        const matches = yield* fs
          .glob("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
            cwd: input.worktree,
            absolute: true,
            include: "file",
          })
          .pipe(Effect.orDie)
        const shortest = matches.sort((a, b) => a.length - b.length)[0]
        if (!shortest) return

        const buffer = yield* fs.readFile(shortest).pipe(Effect.orDie)
        const base64 = Buffer.from(buffer).toString("base64")
        const mime = AppFileSystem.mimeType(shortest)
        const url = `data:${mime};base64,${base64}`
        yield* update({ projectID: input.id, icon: { url } })
      })

      const PROJECT_SELECT = `SELECT id, name, worktree, vcs, icon_url, icon_color, sandboxes, commands,
              time_created, time_updated, time_initialized FROM project`

      const list = Effect.fn("Project.list")(function* () {
        const rows = yield* Effect.promise(() => zengramDb().query<ZengramProjectRow>(PROJECT_SELECT, []))
        return rows.map(zengramRowToProjectInfo)
      })

      const get = Effect.fn("Project.get")(function* (id: ProjectID) {
        const rows = yield* Effect.promise(() =>
          zengramDb().query<ZengramProjectRow>(`${PROJECT_SELECT} WHERE id = $1`, [id]),
        )
        return rows[0] ? zengramRowToProjectInfo(rows[0]) : undefined
      })

      const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
        yield* Effect.promise(() =>
          zengramDb().execute(
            `UPDATE project SET name=$1, icon_url=$2, icon_color=$3, commands=$4, time_updated=$5 WHERE id=$6`,
            [
              input.name ?? null, input.icon?.url ?? null, input.icon?.color ?? null,
              input.commands ? JSON.stringify(input.commands) : null,
              Date.now(), input.projectID,
            ],
          ),
        )
        const rows = yield* Effect.promise(() =>
          zengramDb().query<ZengramProjectRow>(`${PROJECT_SELECT} WHERE id = $1`, [input.projectID]),
        )
        if (!rows[0]) throw new Error(`Project not found: ${input.projectID}`)
        const data = zengramRowToProjectInfo(rows[0])
        yield* emitUpdated(data)
        return data
      })

      const initGit = Effect.fn("Project.initGit")(function* (input: { directory: string; project: Info }) {
        if (input.project.vcs === "git") return input.project
        if (!(yield* Effect.sync(() => which("git")))) throw new Error("Git is not installed")
        const result = yield* git(["init", "--quiet"], { cwd: input.directory })
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || result.text.trim() || "Failed to initialize git repository")
        }
        const { project } = yield* fromDirectory(input.directory)
        return project
      })

      const setInitialized = Effect.fn("Project.setInitialized")(function* (id: ProjectID) {
        yield* Effect.promise(() =>
          zengramDb().execute(`UPDATE project SET time_initialized=$1 WHERE id=$2`, [Date.now(), id]),
        )
      })

      const sandboxes = Effect.fn("Project.sandboxes")(function* (id: ProjectID) {
        const rows = yield* Effect.promise(() =>
          zengramDb().query<{ sandboxes: string[] | null }>(`SELECT sandboxes FROM project WHERE id = $1`, [id]),
        )
        if (!rows[0]) return []
        const sboxes = rows[0].sandboxes ?? []
        return yield* Effect.forEach(
          sboxes,
          (dir) =>
            fs.isDir(dir).pipe(
              Effect.orDie,
              Effect.map((ok) => (ok ? dir : undefined)),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))
      })

      const addSandbox = Effect.fn("Project.addSandbox")(function* (id: ProjectID, directory: string) {
        yield* Effect.promise(async () => {
          const zdb = zengramDb()
          const rows = await zdb.query<{ sandboxes: string[] | null }>(
            `SELECT sandboxes FROM project WHERE id = $1`,
            [id],
          )
          if (!rows[0]) throw new Error(`Project not found: ${id}`)
          const sboxes = [...(rows[0].sandboxes ?? [])]
          if (!sboxes.includes(directory)) sboxes.push(directory)
          await zdb.execute(
            `UPDATE project SET sandboxes=$1, time_updated=$2 WHERE id=$3`,
            [JSON.stringify(sboxes), Date.now(), id],
          )
        })
        const rows = yield* Effect.promise(() =>
          zengramDb().query<ZengramProjectRow>(`${PROJECT_SELECT} WHERE id = $1`, [id]),
        )
        yield* emitUpdated(zengramRowToProjectInfo(rows[0]!))
      })

      const removeSandbox = Effect.fn("Project.removeSandbox")(function* (id: ProjectID, directory: string) {
        yield* Effect.promise(async () => {
          const zdb = zengramDb()
          const rows = await zdb.query<{ sandboxes: string[] | null }>(
            `SELECT sandboxes FROM project WHERE id = $1`,
            [id],
          )
          if (!rows[0]) throw new Error(`Project not found: ${id}`)
          const sboxes = (rows[0].sandboxes ?? []).filter((s) => s !== directory)
          await zdb.execute(
            `UPDATE project SET sandboxes=$1, time_updated=$2 WHERE id=$3`,
            [JSON.stringify(sboxes), Date.now(), id],
          )
        })
        const rows = yield* Effect.promise(() =>
          zengramDb().query<ZengramProjectRow>(`${PROJECT_SELECT} WHERE id = $1`, [id]),
        )
        yield* emitUpdated(zengramRowToProjectInfo(rows[0]!))
      })

      return Service.of({
        fromDirectory,
        discover,
        list,
        get,
        update,
        initGit,
        setInitialized,
        sandboxes,
        addSandbox,
        removeSandbox,
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(NodePath.layer),
  )
  const { runPromise } = makeRuntime(Service, defaultLayer)

  // ---------------------------------------------------------------------------
  // Promise-based API (delegates to Effect service via runPromise)
  // ---------------------------------------------------------------------------

  export function fromDirectory(directory: string) {
    return runPromise((svc) => svc.fromDirectory(directory))
  }

  export function discover(input: Info) {
    return runPromise((svc) => svc.discover(input))
  }

  const _PROJECT_SELECT = `SELECT id, name, worktree, vcs, icon_url, icon_color, sandboxes, commands,
      time_created, time_updated, time_initialized FROM project`

  export async function list(): Promise<Info[]> {
    const rows = await zengramDb().query<ZengramProjectRow>(_PROJECT_SELECT, [])
    return rows.map(zengramRowToProjectInfo)
  }

  export async function get(id: ProjectID): Promise<Info | undefined> {
    const rows = await zengramDb().query<ZengramProjectRow>(
      `${_PROJECT_SELECT} WHERE id = $1`,
      [id],
    )
    return rows[0] ? zengramRowToProjectInfo(rows[0]) : undefined
  }

  export async function setInitialized(id: ProjectID): Promise<void> {
    await zengramDb().execute(`UPDATE project SET time_initialized=$1 WHERE id=$2`, [Date.now(), id])
  }

  export function initGit(input: { directory: string; project: Info }) {
    return runPromise((svc) => svc.initGit(input))
  }

  export function update(input: UpdateInput) {
    return runPromise((svc) => svc.update(input))
  }

  export function sandboxes(id: ProjectID) {
    return runPromise((svc) => svc.sandboxes(id))
  }

  export function addSandbox(id: ProjectID, directory: string) {
    return runPromise((svc) => svc.addSandbox(id, directory))
  }

  export function removeSandbox(id: ProjectID, directory: string) {
    return runPromise((svc) => svc.removeSandbox(id, directory))
  }
}

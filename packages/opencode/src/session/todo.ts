import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { makeRuntime } from "@/effect/run-service"
import { SessionID } from "./schema"
import { Effect, Layer, ServiceMap } from "effect"
import z from "zod"
import { zengramDb } from "@/storage/db.zengram"

export namespace Todo {
  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: SessionID.zod,
        todos: z.array(Info),
      }),
    ),
  }

  export interface Interface {
    readonly update: (input: { sessionID: SessionID; todos: Info[] }) => Effect.Effect<void>
    readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionTodo") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service

      const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Info[] }) {
        yield* Effect.promise(async () => {
          const db = zengramDb()
          await db.execute(`DELETE FROM task WHERE session_id = $1`, [input.sessionID])
          const now = Date.now() * 1000
          for (let i = 0; i < input.todos.length; i++) {
            const todo = input.todos[i]!
            const id = `${input.sessionID}:${i}`
            await db.execute(
              `INSERT INTO task (id, session_id, title, status, priority, time_created)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [id, input.sessionID, todo.content, todo.status, todo.priority, now],
            )
          }
        })
        yield* bus.publish(Event.Updated, input)
      })

      const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
        return yield* Effect.promise(async () => {
          const db = zengramDb()
          const rows = await db.query<{ title: string; status: string; priority: string }>(
            `SELECT title, status, priority FROM task WHERE session_id = $1 ORDER BY time_created ASC`,
            [sessionID],
          )
          return rows.map((row) => ({
            content: row.title,
            status: row.status,
            priority: row.priority,
          }))
        })
      })

      return Service.of({ update, get })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function update(input: { sessionID: SessionID; todos: Info[] }) {
    return runPromise((svc) => svc.update(input))
  }

  export async function get(sessionID: SessionID) {
    return runPromise((svc) => svc.get(sessionID))
  }
}

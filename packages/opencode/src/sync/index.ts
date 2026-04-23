import z from "zod"
import type { ZodObject } from "zod"
import { EventEmitter } from "events"
import { Bus as ProjectBus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { EventID } from "./schema"

export namespace SyncEvent {
  export type Definition = {
    type: string
    version: number
    aggregate: string
    schema: z.ZodObject

    // This is temporary and only exists for compatibility with bus
    // event definitions
    properties: z.ZodObject
  }

  export type Event<Def extends Definition = Definition> = {
    id: string
    aggregateID: string
    data: z.infer<Def["schema"]>
  }

  export type SerializedEvent<Def extends Definition = Definition> = Event<Def> & { type: string }

  // Zengram projector (async, no db parameter needed)
  type AsyncProjectorFunc = (data: unknown) => Promise<void>

  export const registry = new Map<string, Definition>()
  let asyncProjectors: Map<Definition, AsyncProjectorFunc> | undefined
  const versions = new Map<string, number>()
  let frozen = false
  let convertEvent: (type: string, event: Event["data"]) => Promise<Record<string, unknown>> | Record<string, unknown>

  const Bus = new EventEmitter<{ event: [{ def: Definition; event: Event }] }>()

  export function reset() {
    frozen = false
    asyncProjectors = undefined
    convertEvent = (_, data) => data
  }

  export function init(input: {
    asyncProjectors?: Array<[Definition, AsyncProjectorFunc]>
    convertEvent?: typeof convertEvent
  }) {
    if (input.asyncProjectors) asyncProjectors = new Map(input.asyncProjectors)

    // Install all the latest event defs to the bus. We only ever emit
    // latest versions from code, and keep around old versions for
    // replaying. Replaying does not go through the bus, and it
    // simplifies the bus to only use unversioned latest events
    for (let [type, version] of versions.entries()) {
      let def = registry.get(versionedType(type, version))!
      BusEvent.define(def.type, def.properties || def.schema)
    }

    // Freeze the system so it clearly errors if events are defined
    // after `init` which would cause bugs
    frozen = true
    convertEvent = input.convertEvent || ((_, data) => data)
  }

  export function versionedType<A extends string>(type: A): A
  export function versionedType<A extends string, B extends number>(type: A, version: B): `${A}/${B}`
  export function versionedType(type: string, version?: number) {
    return version ? `${type}.${version}` : type
  }

  export function define<
    Type extends string,
    Agg extends string,
    Schema extends ZodObject<Record<Agg, z.ZodType<string>>>,
    BusSchema extends ZodObject = Schema,
  >(input: { type: Type; version: number; aggregate: Agg; schema: Schema; busSchema?: BusSchema }) {
    if (frozen) {
      throw new Error("Error defining sync event: sync system has been frozen")
    }

    const def = {
      type: input.type,
      version: input.version,
      aggregate: input.aggregate,
      schema: input.schema,
      properties: input.busSchema ? input.busSchema : input.schema,
    }

    versions.set(def.type, Math.max(def.version, versions.get(def.type) || 0))
    registry.set(versionedType(def.type, def.version), def)
    return def
  }

  /**
   * Register an async projector for Zengram storage backend.
   */
  export function projectAsync<Def extends Definition>(
    def: Def,
    func: (data: Event<Def>["data"]) => Promise<void>,
  ): [Definition, AsyncProjectorFunc] {
    return [def, func as AsyncProjectorFunc]
  }

  function publishEvent(def: Definition, event: Event, options: { publish: boolean }) {
    Bus.emit("event", { def, event })

    if (options?.publish) {
      const result = convertEvent(def.type, event.data)
      if (result instanceof Promise) {
        result.then((data) => {
          ProjectBus.publish({ type: def.type, properties: def.schema }, data)
        })
      } else {
        ProjectBus.publish({ type: def.type, properties: def.schema }, result)
      }
    }
  }

  // ── Zengram async path ────────────────────────────────────────────────────

  async function processAsync<Def extends Definition>(def: Def, event: Event<Def>, options: { publish: boolean }) {
    if (asyncProjectors == null) {
      throw new Error("No async projectors available. Call `SyncEvent.init` with asyncProjectors")
    }
    const projector = asyncProjectors.get(def)
    if (!projector) throw new Error(`Async projector not found for event: ${def.type}`)

    await projector(event.data)
    publishEvent(def, event, options)
  }

  export async function replay(event: SerializedEvent, options?: { republish: boolean }) {
    const def = registry.get(event.type)
    if (!def) throw new Error(`Unknown event type: ${event.type}`)
    await processAsync(def, event, { publish: !!options?.republish })
  }

  /** Run an event. Returns a Promise (async for Zengram, resolves immediately for SQLite). */
  export function run<Def extends Definition>(def: Def, data: Event<Def>["data"]): Promise<void> {
    const agg = (data as Record<string, string>)[def.aggregate]
    if (agg == null) {
      throw new Error(`SyncEvent.run: "${def.aggregate}" required but not found: ${JSON.stringify(data)}`)
    }
    if (def.version !== versions.get(def.type)) {
      throw new Error(`SyncEvent.run: running old versions of events is not allowed: ${def.type}`)
    }

    const id = EventID.ascending()
    const event = { id, aggregateID: agg, data }
    return processAsync(def, event, { publish: true })
  }

  export function remove(_aggregateID: string) {
    // Event log lives in Zengram; no cleanup needed here.
  }

  export function subscribeAll(handler: (event: { def: Definition; event: Event }) => void) {
    Bus.on("event", handler)
    return () => Bus.off("event", handler)
  }

  export function payloads() {
    return z
      .union(
        registry
          .entries()
          .map(([type, def]) => {
            return z
              .object({
                type: z.literal(type),
                aggregate: z.literal(def.aggregate),
                data: def.schema,
              })
              .meta({ ref: "SyncEvent" + "." + def.type })
          })
          .toArray() as any,
      )
      .meta({ ref: "SyncEvent" })
  }
}

import { homedir } from "node:os"
import { Clock, Config, Console, Data, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect"
import { runAgent } from "./agent.ts"
import { Page } from "./browser.ts"
import { AgentState } from "./state.ts"

export const statuses = ["on_sale", "sold_out", "not_yet_on_sale", "resale_only"] as const
export type Status = (typeof statuses)[number]

export const Availability = Schema.Struct({
  event: Schema.String,
  status: Schema.Literals([...statuses, "blocked", "unknown"]),
  categories: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      price: Schema.String,
      status: Schema.Literals(["available", "sold_out", "not_shown"]),
    }),
  ),
  note: Schema.optionalKey(Schema.String),
})
export type Availability = typeof Availability.Type

const Watched = Schema.Struct({
  lastGood: Schema.optionalKey(Availability),
  lastGoodAt: Schema.optionalKey(Schema.String),
  failingSince: Schema.optionalKey(Schema.String),
  lastFailure: Schema.optionalKey(Schema.String),
})
type Watched = typeof Watched.Type

const StoreJson = Schema.fromJsonString(Schema.Record(Schema.String, Watched))
const SchemaJson = Schema.fromJsonString(Schema.Json)

export class WatchError extends Data.TaggedError("WatchError")<{ readonly message: string }> {}

const task = (url: string, schema: string) =>
  `
Check ticket availability for the event at ${url}. Read it from the event page and its ticket listing, and stop at the point where a purchase would begin.

Before answering, write the result with state_write under the key "availability", as a value matching this JSON Schema:
${schema}

Choose status from what the page shows: on_sale when at least one category can be bought, sold_out when every category is sold out, not_yet_on_sale when sales have not opened, resale_only when only resale tickets are offered, blocked when a bot check, captcha or waiting room keeps you from the page (describe it in note), unknown when the page does not say. List every price category the page shows.
`.trim()

// "blocked" and "unknown" mean the check could not tell, so they are failures rather than an availability to compare.
type Outcome = { readonly _tag: "Checked"; readonly availability: Availability } | { readonly _tag: "Failed"; readonly reason: string }

const check = (url: string, maxSteps: number) =>
  Effect.gen(function* () {
    const schema = yield* Schema.encodeEffect(SchemaJson)(Schema.toJsonSchemaDocument(Availability).schema as Schema.Json)
    const { state } = yield* runAgent(task(url, schema), { maxSteps })
    if (!Object.hasOwn(state, "availability")) {
      return { _tag: "Failed", reason: "the agent finished without writing an availability entry" } as const
    }
    const availability = yield* Schema.decodeUnknownEffect(Availability)(state["availability"]).pipe(
      Effect.mapError((error) => new WatchError({ message: `the agent's availability entry has the wrong shape: ${error.message}` })),
    )
    if (availability.status === "blocked" || availability.status === "unknown") {
      return { _tag: "Failed", reason: `${availability.status}${availability.note ? `: ${availability.note}` : ""}` } as const
    }
    return { _tag: "Checked", availability } as const
  }).pipe(
    Effect.provide(Layer.mergeAll(Page.layer, AgentState.layer)),
    Effect.catch((error) => Effect.succeed({ _tag: "Failed", reason: error.message } as const)),
  ) satisfies Effect.Effect<Outcome, never, unknown>

export const describeChanges = (previous: Availability, next: Availability): ReadonlyArray<string> => {
  const changes: Array<string> = []
  if (previous.status !== next.status) changes.push(`status ${previous.status} → ${next.status}`)
  const before = new Map(previous.categories.map((category) => [category.name, category]))
  const after = new Map(next.categories.map((category) => [category.name, category]))
  for (const [name, category] of after) {
    const old = before.get(name)
    if (old === undefined) changes.push(`new category ${name}: ${category.status}, ${category.price}`)
    else {
      if (old.status !== category.status) changes.push(`${name}: ${old.status} → ${category.status}`)
      if (old.price !== category.price) changes.push(`${name}: price ${old.price} → ${category.price}`)
    }
  }
  for (const name of before.keys()) if (!after.has(name)) changes.push(`category ${name} no longer listed`)
  return changes
}

export const notify = (title: string, message: string) =>
  process.platform === "darwin"
    ? Effect.tryPromise(
        () =>
          Bun.$`osascript -e ${"on run argv"} -e ${"display notification (item 1 of argv) with title (item 2 of argv)"} -e ${"end run"} ${message} ${title}`.quiet(),
      ).pipe(Effect.ignore({ log: "Warn" }))
    : Effect.void

const summary = (availability: Availability) =>
  `${availability.event}: ${availability.status}` +
  (availability.categories.length > 0
    ? ` (${availability.categories.map((c) => `${c.name} ${c.status} ${c.price}`).join("; ")})`
    : "")

export const watch = (
  urls: ReadonlyArray<string>,
  options: {
    readonly everyMinutes: number
    readonly once: boolean
    readonly maxSteps: number
    readonly until: ReadonlyArray<Status>
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const storeFile = yield* Config.String("WATCH_STATE_FILE").pipe(
      Config.withDefault(path.join(homedir(), ".ticket-scraper", "watch.json")),
    )

    const load = Effect.gen(function* () {
      if (!(yield* fs.exists(storeFile))) return {} as Record<string, Watched>
      return yield* Schema.decodeEffect(StoreJson)(yield* fs.readFileString(storeFile)).pipe(
        Effect.mapError((error) => new WatchError({ message: `${storeFile} is not a valid watch state file (fix or delete it): ${error.message}` })),
      )
    })
    const save = (store: Record<string, Watched>) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(storeFile), { recursive: true })
        yield* fs.writeFileString(storeFile, yield* Schema.encodeEffect(StoreJson)(store))
      })

    const checkOne = (url: string) =>
      Effect.gen(function* () {
        const now = new Date(yield* Clock.currentTimeMillis).toISOString()
        const store = yield* load
        const previous = store[url] ?? {}
        const outcome = yield* check(url, options.maxSteps)

        if (outcome._tag === "Failed") {
          yield* Console.error(`[${now}] ${url} check failed: ${outcome.reason}`)
          if (previous.failingSince === undefined) yield* notify("Ticket check failing", `${url}: ${outcome.reason}`)
          yield* save({ ...store, [url]: { ...previous, failingSince: previous.failingSince ?? now, lastFailure: outcome.reason } })
          return "failed" as const
        }

        const next = outcome.availability
        const reached = options.until.some((status) => status === next.status)
        if (previous.lastGood === undefined) {
          yield* Console.log(`[${now}] ${url} first check: ${summary(next)}`)
        } else {
          const changes = describeChanges(previous.lastGood, next)
          if (changes.length === 0) yield* Console.log(`[${now}] ${url} unchanged: ${next.status}`)
          else {
            yield* Console.log(`[${now}] ${url} CHANGED: ${changes.join("; ")}`)
            if (!reached) yield* notify(`Tickets changed: ${next.event}`, changes.join("; "))
          }
        }
        yield* save({ ...store, [url]: { lastGood: next, lastGoodAt: now } })
        if (!reached) return "checked" as const
        yield* Console.log(`[${now}] ${url} REACHED ${next.status}, no longer watching it`)
        yield* notify(`Tickets ${next.status}: ${next.event}`, summary(next))
        return "reached" as const
      })

    const watching = new Set(urls)
    const total = watching.size
    const round = Effect.suspend(() =>
      Effect.forEach([...watching], (url) =>
        checkOne(url).pipe(Effect.tap((result) => Effect.sync(() => result === "reached" && watching.delete(url)))),
      ),
    ).pipe(Effect.map((results) => results.filter((result) => result === "failed").length))
    if (!options.once) {
      yield* round.pipe(
        Effect.repeat({ schedule: Schedule.spaced(`${options.everyMinutes} minutes`), until: () => watching.size === 0 }),
      )
      return
    }
    const failed = yield* round
    if (failed > 0) return yield* new WatchError({ message: `${failed} of ${total} checks failed` })
  })

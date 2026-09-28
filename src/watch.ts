import { Clock, Console, Data, Effect } from "effect"
import { eventIdOf, eventim, freeTickets, readAvailability, readMapping } from "./providers/eventim.ts"
import type { Listener } from "./listeners.ts"
import { Availability, makeWatchState } from "./watch-state.ts"
import { notify } from "./notifications.ts"

export const statuses = ["on_sale", "sold_out", "not_yet_on_sale", "resale_only"] as const
export type Status = (typeof statuses)[number]

export class WatchError extends Data.TaggedError("WatchError")<{ readonly message: string }> {}

type Outcome = { readonly _tag: "Checked"; readonly availability: Availability } | { readonly _tag: "Failed"; readonly reason: string; readonly blocked?: boolean }

// The seat map API answers in about 100 ms without a browser, and a sold-out event serves no seat map. It has no
// prices, so each category's price is left empty.
const checkWithApi = (url: URL, eventId: string) =>
  Effect.gen(function* () {
    const event = url.pathname.split("/").filter(Boolean).at(-1) ?? url.pathname
    const mapping = yield* readMapping(eventId)
    const availability = mapping._tag === "Ok" ? yield* readAvailability(eventId) : mapping
    if (mapping._tag === "NoSeatmap" || availability._tag === "NoSeatmap")
      return { _tag: "Checked", availability: { event, status: "sold_out", categories: [], note: "Eventim serves no seat map" } } as const
    const free = freeTickets(mapping.value, availability.value)
    const categories = mapping.value.priceCategories.map(({ name }) => ({ name, price: "", status: (free.get(name) ?? 0) > 0 ? "available" : "sold_out" }) as const)
    return { _tag: "Checked", availability: { event, status: free.size > 0 ? "on_sale" : "sold_out", categories } } as const
  }).pipe(Effect.catch((error) => Effect.succeed(error._tag === "AccessDenied" ? { _tag: "Failed", reason: `${error.reason} from the API`, blocked: true } as const : { _tag: "Failed", reason: error.message } as const))) satisfies Effect.Effect<Outcome, never, unknown>

const check = (url: string) => {
  const event = new URL(url)
  const eventId = eventIdOf(event)
  return eventim.matches(event) && eventId !== undefined
    ? checkWithApi(event, eventId)
    : Effect.succeed({ _tag: "Failed", reason: `${url} is not a Fnac Spectacles event page (…/event/<name>-<id>/)` } as const)
}

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

const summary = (availability: Availability) =>
  `${availability.event}: ${availability.status}` +
  (availability.categories.length > 0
    ? ` (${availability.categories.map((c) => `${c.name} ${c.status} ${c.price}`).join("; ")})`
    : "")

export const watch = (
  urls: ReadonlyArray<string>,
  options: {
    readonly everySeconds: number
    readonly once: boolean
    readonly until: ReadonlyArray<Status>
    readonly browser?: "chrome" | "edge"
    readonly profileKey?: string
  },
  listeners: readonly Listener[] = [],
) =>
  Effect.gen(function* () {
    const state = yield* makeWatchState({ browser: options.browser ?? "chrome", profileKey: options.profileKey ?? "default" })

    const checkOne = (url: string) =>
      Effect.gen(function* () {
        const listener = listeners.find((listener) => listener.url === url)
        if (listener) yield* listener.update({ status: "checking", message: "Checking availability", nextCheckAt: undefined })
        const now = new Date(yield* Clock.currentTimeMillis).toISOString()
        const previous = yield* state.load(url)
        const outcome = yield* check(url)

        if (outcome._tag === "Failed") {
          yield* Console.error(`[${now}] ${url} check failed: ${outcome.reason}`)
          if (previous.failingSince === undefined) yield* notify("Ticket check failing", `${url}: ${outcome.reason}`)
          yield* state.save(url, { ...previous, failingSince: previous.failingSince ?? now, lastFailure: outcome.reason })
          if (listener) yield* listener.update({ status: "blocked" in outcome && outcome.blocked ? "blocked" : options.once ? "failed" : "retrying", message: outcome.reason, lastCheckAt: yield* Clock.currentTimeMillis })
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
        yield* state.save(url, { lastGood: next, lastGoodAt: now })
        if (listener) yield* listener.update({ status: reached || options.once ? "completed" : "waiting", message: summary(next), lastCheckAt: yield* Clock.currentTimeMillis })
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
    ).pipe(
      Effect.map((results) => results.filter((result) => result === "failed").length),
    )
    if (!options.once) {
      while (watching.size > 0) {
        const startedAt = yield* Clock.currentTimeMillis
        yield* round
        if (watching.size === 0) break
        const nextCheckAt = Math.max(yield* Clock.currentTimeMillis, startedAt + options.everySeconds * 1000)
        for (const listener of listeners) if (watching.has(listener.url)) yield* listener.update({ nextCheckAt })
        yield* Effect.sleep(Math.max(0, nextCheckAt - (yield* Clock.currentTimeMillis)))
      }
      return
    }
    const failed = yield* round
    if (failed > 0) return yield* new WatchError({ message: `${failed} of ${total} checks failed` })
  })

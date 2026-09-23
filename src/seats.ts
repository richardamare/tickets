import { Context, Data, Effect, Layer, Schema } from "effect"
import type { BrowserError, Page } from "./browser.ts"

export const Seat = Schema.Struct({
  block: Schema.String,
  row: Schema.String,
  position: Schema.Number,
  category: Schema.String,
  available: Schema.Boolean,
})
export type Seat = typeof Seat.Type

export const SeatsJson = Schema.fromJsonString(Schema.Array(Seat), { space: 2 })

export class SeatsError extends Data.TaggedError("SeatsError")<{ readonly message: string }> {}

export interface SeatProvider {
  readonly name: string
  readonly matches: (url: URL) => boolean
  readonly read: (url: URL) => Effect.Effect<ReadonlyArray<Seat>, BrowserError | SeatsError, Page>
}

export class SeatProviders extends Context.Service<
  SeatProviders,
  {
    readonly providerFor: (url: string) => Effect.Effect<{ readonly provider: SeatProvider; readonly url: URL }, SeatsError>
  }
>()("SeatProviders") {
  static readonly layer = (providers: ReadonlyArray<SeatProvider>) =>
    Layer.succeed(SeatProviders, {
      providerFor: (url) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => new URL(url),
            catch: () => new SeatsError({ message: `${url} is not a URL` }),
          })
          const provider = providers.find((candidate) => candidate.matches(parsed))
          if (provider === undefined) {
            return yield* new SeatsError({
              message: `no seat provider handles ${parsed.hostname}; supported: ${providers.map((candidate) => candidate.name).join(", ")}`,
            })
          }
          return { provider, url: parsed }
        }),
    })
}

const tally = (seats: ReadonlyArray<Seat>, key: (seat: Seat) => string) => {
  const counts = new Map<string, { free: number; total: number }>()
  for (const seat of seats) {
    const count = counts.get(key(seat)) ?? { free: 0, total: 0 }
    count.total++
    if (seat.available) count.free++
    counts.set(key(seat), count)
  }
  return counts
}

export const describeSeats = (seats: ReadonlyArray<Seat>) => {
  const free = seats.filter((seat) => seat.available)
  const lines = [`${free.length} of ${seats.length} seats free`, "", "By category:"]
  for (const [category, { free, total }] of tally(seats, (seat) => seat.category)) lines.push(`  ${category}: ${free} of ${total} free`)
  lines.push("", "Rows with free seats:")
  const rows = new Map<string, Array<Seat>>()
  for (const seat of free) rows.set(`${seat.block} ${seat.row}`, [...(rows.get(`${seat.block} ${seat.row}`) ?? []), seat])
  for (const [row, rowSeats] of rows) {
    const categories = [...tally(rowSeats, (seat) => seat.category)].map(([category, { free }]) => `${category} ×${free}`)
    lines.push(`  ${row}: ${rowSeats.length} (${categories.join(", ")})`)
  }
  return lines.join("\n")
}

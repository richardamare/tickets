import { Context, Data, Effect, Layer, Schema } from "effect"
import type { BrowserError, Page } from "./browser.ts"

export const Seat = Schema.Struct({
  id: Schema.String,
  block: Schema.String,
  row: Schema.String,
  position: Schema.Number,
  category: Schema.String,
  available: Schema.Boolean,
})
export type Seat = typeof Seat.Type

export const SeatsJson = Schema.fromJsonString(Schema.Array(Seat), { space: 2 })

export type Cart = { readonly url: string; readonly contents: string }

export class SeatsError extends Data.TaggedError("SeatsError")<{ readonly message: string }> {}

export interface SeatProvider {
  readonly name: string
  readonly matches: (url: URL) => boolean
  readonly read: (url: URL) => Effect.Effect<ReadonlyArray<Seat>, BrowserError | SeatsError, Page>
  // Stops at the cart: the seats are held for the site's reservation time and nothing is paid.
  readonly addToCart: (url: URL, seatIds: ReadonlyArray<string>) => Effect.Effect<Cart, BrowserError | SeatsError, Page>
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
    const k = key(seat)
    const count = counts.get(k) ?? { free: 0, total: 0 }
    count.total++
    if (seat.available) count.free++
    counts.set(k, count)
  }
  return counts
}

export const describeSeats = (seats: ReadonlyArray<Seat>) => {
  const free = seats.filter((seat) => seat.available)
  const lines = [`${free.length} of ${seats.length} seats free`, "", "By category:"]
  for (const [category, { free, total }] of tally(seats, (seat) => seat.category)) lines.push(`  ${category}: ${free} of ${total} free`)
  lines.push("", "Rows with free seats:")
  const rows = new Map<string, Array<Seat>>()
  for (const seat of free) {
    const row = `${seat.block} ${seat.row}`
    const rowSeats = rows.get(row)
    if (rowSeats === undefined) rows.set(row, [seat])
    else rowSeats.push(seat)
  }
  for (const [row, rowSeats] of rows) {
    const categories = [...tally(rowSeats, (seat) => seat.category)].map(([category, { free }]) => `${category} ×${free}`)
    lines.push(`  ${row}: ${rowSeats.length} (${categories.join(", ")})`)
  }
  return lines.join("\n")
}

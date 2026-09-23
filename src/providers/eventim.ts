import { Effect, Fiber, Schema } from "effect"
import { Page, type PageShape } from "../browser.ts"
import { type Seat, type SeatProvider, SeatsError } from "../seats.ts"

const SeatDelta = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])

// Eventim's public seat map API. In every list the first entry holds absolute values and each later
// entry the difference from the one before it; seat geometry restarts that sequence on every row.
export const SeatmapJson = Schema.Struct({
  areas: Schema.Array(
    Schema.Struct({
      blocks: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          rows: Schema.Array(Schema.Struct({ seats: Schema.Array(Schema.Array(SeatDelta)) })),
        }),
      ),
    }),
  ),
  labels: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.String, point: Schema.Tuple([Schema.Number, Schema.Number]) }),
  ),
})

export const MappingJson = Schema.Struct({
  priceCategories: Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  seats: Schema.Array(SeatDelta),
})

export const AvailabilityJson = Schema.Struct({
  seats: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
})

export const decodeSeatmap = (
  seatmap: typeof SeatmapJson.Type,
  mapping: typeof MappingJson.Type,
  availability: typeof AvailabilityJson.Type,
): ReadonlyArray<Seat> => {
  const categoryNames = new Map(mapping.priceCategories.map((category) => [category.id, category.name]))
  const categoryOf = new Map<number, number>()
  let id = 0
  let category = 0
  for (const [idDelta, , categoryDelta] of mapping.seats) {
    id += idDelta
    category += categoryDelta
    categoryOf.set(id, category)
  }
  const status = new Map<number, number>()
  id = 0
  for (const [idDelta, state] of availability.seats) {
    id += idDelta
    status.set(id, state)
  }

  const rowLabels = seatmap.labels.filter((label) => label.type === "ROW")
  const nearestLabel = (x: number, y: number) =>
    rowLabels.reduce<{ text: string; distance: number } | undefined>((best, { text, point: [lx, ly] }) => {
      const distance = (lx - x) ** 2 + (ly - y) ** 2
      return best === undefined || distance < best.distance ? { text, distance } : best
    }, undefined)?.text ?? "?"

  const seats: Array<Seat> = []
  for (const area of seatmap.areas)
    for (const block of area.blocks)
      for (const row of block.rows) {
        let position = 0
        for (const segment of row.seats) {
          let seatId = 0
          let x = 0
          let y = 0
          let label: string | undefined
          for (const [idDelta, dx, dy] of segment) {
            seatId += idDelta
            x += dx
            y += dy
            position++
            label ??= nearestLabel(x, y)
            const categoryId = categoryOf.get(seatId)
            const category = categoryId === undefined ? undefined : categoryNames.get(categoryId)
            // Seats drawn on the map without one of the event's price categories are not for sale.
            if (category === undefined) continue
            seats.push({
              block: block.name,
              row: label,
              position,
              category,
              available: status.get(seatId) === 1,
            })
          }
        }
      }
  return seats
}

const response = <S extends Schema.Top>(page: PageShape, kind: "seatmap" | "mapping" | "availability", schema: S) => {
  const endpoint = new RegExp(`/seatmap/api/public/${kind}/[^/?]+\\?`)
  return page.responseText((url) => endpoint.test(url)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.mapError((error) =>
      error._tag === "BrowserError" ? error : new SeatsError({ message: `Eventim's ${kind} response is not what the provider expects: ${error.message}` }),
    ),
  )
}

const read = (url: URL) =>
  Page.use((page) =>
    Effect.gen(function* () {
      yield* page.goto(url.href)
      const seatingChart = page.locator("a.seat-switch:has(.icon-seatmap)")
      if ((yield* seatingChart.count) === 0) return yield* new SeatsError({ message: `${url} offers no seating chart` })
      // The seat map requests fire on the click, so listen for them before clicking.
      const responses = yield* Effect.forkChild(
        Effect.all(
          [response(page, "seatmap", SeatmapJson), response(page, "mapping", MappingJson), response(page, "availability", AvailabilityJson)],
          { concurrency: "unbounded" },
        ),
      )
      yield* Effect.yieldNow
      yield* seatingChart.first().mouseClick
      const [seatmap, mapping, availability] = yield* Fiber.join(responses)
      return decodeSeatmap(seatmap, mapping, availability)
    }),
  )

// Only shops verified against this page layout; other Eventim storefronts share the API but not necessarily the page.
const hosts = ["fnacspectacles.com"]

export const eventim: SeatProvider = {
  name: "eventim (fnacspectacles.com)",
  matches: (url) => hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)),
  read,
}

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
  let label = "?"
  for (const seat of layout(seatmap)) {
    if (seat.startsSegment) label = nearestLabel(seat.x, seat.y)
    const categoryId = categoryOf.get(seat.id)
    const category = categoryId === undefined ? undefined : categoryNames.get(categoryId)
    // Seats drawn on the map without one of the event's price categories are not for sale.
    if (category === undefined) continue
    seats.push({
      id: String(seat.id),
      block: seat.block,
      row: label,
      position: seat.position,
      category,
      available: status.get(seat.id) === 1,
    })
  }
  return seats
}

// Every seat with its map coordinates, which are also the cx and cy of its circle once the map draws it.
function* layout(seatmap: typeof SeatmapJson.Type) {
  for (const area of seatmap.areas)
    for (const block of area.blocks)
      for (const row of block.rows) {
        let position = 0
        for (const segment of row.seats) {
          let id = 0
          let x = 0
          let y = 0
          for (const [index, [idDelta, dx, dy]] of segment.entries()) {
            id += idDelta
            x += dx
            y += dy
            position++
            yield { id, x, y, block: block.name, position, startsSegment: index === 0 }
          }
        }
      }
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

const seatingChart = "a.seat-switch:has(.icon-seatmap)"
const cartButton = ".seatmap-tab button.btn-primary:not(.disabled):has-text('Ticket')"
// Clicking this heading closes a hover menu or tooltip and leaves the cursor clear of the map's controls.
const clearSpot = ".seatmap-tab >> text=Selected seats & discount"

// Sleeknote marketing popups cover the page under a randomised tag name.
const removePopups = (page: PageShape) =>
  page.use("remove popups", (raw) =>
    raw.locator("*").evaluateAll((elements) => {
      for (const element of elements) if (element.tagName.startsWith("SLEEKNOTE")) element.remove()
    }),
  )

const click = (page: PageShape, selector: string, clear = clearSpot) => {
  const once = removePopups(page).pipe(Effect.andThen(page.locator(selector).first().mouseClick))
  return once.pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`Click on ${selector} did not land (${error.message}); clicking ${clear} to clear the way`).pipe(
        Effect.andThen(page.locator(clear).first().mouseClick.pipe(Effect.ignore)),
      ),
    ),
    Effect.retry({ times: 2 }),
  )
}

// consentmanager's banner covers the page until answered; declining keeps the site working.
const declineConsent = (page: PageShape) =>
  Effect.gen(function* () {
    const decline = ".cmpboxbtnno"
    const shown = yield* page.use("look for the consent banner", (raw) =>
      raw.locator(decline).first().waitFor({ state: "visible", timeout: 3_000 }).then(
        () => true,
        () => false,
      ),
    )
    if (!shown) return
    yield* Effect.logInfo("Declining the cookie consent banner")
    yield* page.locator(decline).first().mouseClick
  })

const openSeatingChart = (page: PageShape, url: URL) =>
  Effect.gen(function* () {
    yield* page.goto(url.href)
    yield* declineConsent(page)
    if ((yield* page.locator(seatingChart).count) === 0) return yield* new SeatsError({ message: `${url} offers no seating chart; pass the event page, …/event/…` })
  })

const read = (url: URL) =>
  Page.use((page) =>
    Effect.gen(function* () {
      yield* openSeatingChart(page, url)
      // The seat map requests fire on the click, so listen for them before clicking.
      const responses = yield* Effect.forkChild(
        Effect.all(
          [response(page, "seatmap", SeatmapJson), response(page, "mapping", MappingJson), response(page, "availability", AvailabilityJson)],
          { concurrency: "unbounded" },
        ),
      )
      yield* Effect.yieldNow
      yield* Effect.logInfo("Opening the seating chart")
      yield* click(page, seatingChart, "h1")
      const [seatmap, mapping, availability] = yield* Fiber.join(responses)
      const seats = decodeSeatmap(seatmap, mapping, availability)
      yield* Effect.logInfo(`Read ${seats.length} seats from the Eventim seat map, ${seats.filter((seat) => seat.available).length} free`)
      return seats
    }),
  )

// The map draws single seats only when zoomed in, and zooms around its centre.
const zoomToSeats = (page: PageShape) =>
  Effect.gen(function* () {
    for (let level = 0; level < 8; level++) {
      const drawn = yield* page.locator("g.seats circle.s").count
      if (drawn > 0) return yield* Effect.logInfo(`The map draws ${drawn} single seats after zooming in ${level} times`)
      yield* Effect.logDebug(`Zooming in (level ${level + 1})`)
      yield* click(page, ".seatmap-tab .js-zoom-in")
      yield* Effect.sleep("1500 millis")
    }
    return yield* new SeatsError({ message: "the seat map did not draw single seats after zooming in 8 times" })
  })

type Matrix = { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number }

// The map draws only the seats inside its view, so a seat is found by its map coordinates and dragged into
// the view until the map draws it, well clear of the controls along the view's top edge.
const bringIntoView = (page: PageShape, seatId: string, point: { readonly x: number; readonly y: number }) =>
  Effect.gen(function* () {
    for (let drag = 0; drag < 12; drag++) {
      const offset = yield* page.use(`locate seat ${seatId}`, (raw) =>
        raw.locator("g.seats").first().evaluate((group, { x, y }) => {
          const ctm = (group as unknown as { getScreenCTM(): Matrix | null }).getScreenCTM()
          const view = group.ownerDocument.querySelector(".js-seatmap-view")?.getBoundingClientRect()
          if (!ctm || !view) return undefined
          const screenX = ctm.a * x + ctm.c * y + ctm.e
          const screenY = ctm.b * x + ctm.d * y + ctm.f
          const inside = screenX > view.left + 60 && screenX < view.right - 60 && screenY > view.top + 140 && screenY < view.bottom - 60
          if (inside) return { x: 0, y: 0 }
          const clamp = (value: number) => Math.max(-250, Math.min(250, value))
          return { x: clamp(view.left + view.width / 2 - screenX), y: clamp(view.top + view.height / 2 - screenY) }
        }, point),
      )
      if (offset === undefined) return yield* new SeatsError({ message: "the seat map has no view to drag" })
      if (offset.x === 0 && offset.y === 0) {
        yield* page.locator(`#s${seatId}`).first().waitFor
        return
      }
      yield* Effect.logDebug(`Seat ${seatId} is outside the view; dragging the map`)
      yield* page.locator(".js-seatmap-view").mouseDrag(offset)
      yield* Effect.sleep("500 millis")
    }
    return yield* new SeatsError({ message: `could not drag seat ${seatId} into view` })
  })

const addToCart = (url: URL, seatIds: ReadonlyArray<string>) =>
  Page.use((page) =>
    Effect.gen(function* () {
      if (seatIds.length === 0) return yield* new SeatsError({ message: "no seats given" })
      yield* Effect.logInfo(`Adding ${seatIds.length} seat(s) to the cart: ${seatIds.join(", ")}`)
      yield* openSeatingChart(page, url)
      const geometry = yield* Effect.forkChild(response(page, "seatmap", SeatmapJson))
      yield* Effect.yieldNow
      yield* Effect.logInfo("Opening the seating chart")
      yield* click(page, seatingChart, "h1")
      const positions = new Map(Array.from(layout(yield* Fiber.join(geometry)), (seat) => [String(seat.id), seat]))
      yield* page.locator("path.bo").first().waitFor
      yield* click(page, clearSpot, "h1")
      yield* zoomToSeats(page)
      for (const [index, seatId] of seatIds.entries()) {
        const point = positions.get(seatId)
        if (point === undefined) return yield* new SeatsError({ message: `seat ${seatId} is not on this event's seat map` })
        yield* bringIntoView(page, seatId, point)
        if ((yield* page.locator(`#s${seatId}.has-hover`).count) === 0)
          return yield* new SeatsError({ message: `seat ${seatId} is not free any more` })
        yield* click(page, `#s${seatId}`)
        yield* page.locator("button.js-tooltip-go >> visible=true").first().waitFor
        const label = yield* page.locator(".tooltipster-base").first().innerText
        yield* Effect.logInfo(`Selected seat ${seatId}: ${label.replace(/\s+/g, " ").replace(/ Continue$/, "")}`)
        yield* click(page, "button.js-tooltip-go >> visible=true")
        yield* page.use(`wait for ${index + 1} ticket(s) in the selection`, (raw) =>
          raw
            .locator(cartButton)
            .filter({ hasText: new RegExp(`\\b${index + 1} Tickets?\\b`) })
            .first()
            .waitFor({ timeout: 15_000 }),
        )
      }
      yield* Effect.logInfo("Going to the cart")
      const cartRequest = yield* Effect.forkChild(
        page.use("wait for the cart request", (raw) =>
          raw
            .waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/api/shoppingCart/"), {
              timeout: 30_000,
            })
            .then((response) => response.status()),
        ),
      )
      yield* Effect.yieldNow
      yield* click(page, cartButton)
      // A refused selection comes back as a bare 403 and the page reloads the event without a message.
      const status = yield* Fiber.join(cartRequest)
      if (status === 403)
        return yield* new SeatsError({
          message:
            "the site refused the selection (HTTP 403), most likely because it would leave a single free seat alone in a row; choose seats that leave no single gap",
        })
      if (status >= 400) return yield* new SeatsError({ message: `the site refused the selection (HTTP ${status})` })
      yield* page.use("wait for the cart", (raw) => raw.waitForURL((next) => !next.href.includes("/event/"), { timeout: 30_000 }))
      yield* page.getByText("Shopping Cart").first().waitFor
      yield* Effect.logInfo(`Seats are in the cart at ${yield* page.url}`)
      const text = yield* page.locator("body").innerText
      const start = text.indexOf("Shopping Cart")
      const end = text.indexOf("Summary", start)
      return { url: yield* page.url, contents: (start === -1 ? text : text.slice(start, end === -1 ? undefined : end)).trim() }
    }),
  )

// Only shops verified against this page layout; other Eventim storefronts share the API but not necessarily the page.
const hosts = ["fnacspectacles.com"]

export const eventim: SeatProvider = {
  name: "eventim (fnacspectacles.com)",
  matches: (url) => hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)),
  read,
  addToCart,
}

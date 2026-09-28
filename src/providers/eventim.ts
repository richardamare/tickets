import { Data, Effect, Fiber, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Page, type PageShape } from "../browser.ts"
import { type Cart, type Seat, type SeatProvider, SeatsError } from "../seats.ts"

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

// Standing areas hold absolute values, unlike the seat lists: [area id, ?, price category id, …] in the
// mapping and [area id, free tickets, …] in the availability.
export const MappingJson = Schema.Struct({
  priceCategories: Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  seats: Schema.Array(SeatDelta),
  generalAdmissions: Schema.optionalKey(
    Schema.Array(Schema.TupleWithRest(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]), [Schema.Unknown])),
  ),
})

export const AvailabilityJson = Schema.Struct({
  seats: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
  generalAdmissions: Schema.optionalKey(
    Schema.Array(Schema.TupleWithRest(Schema.Tuple([Schema.Number, Schema.Number]), [Schema.Unknown])),
  ),
})

// Free tickets per price category name, seated and standing together; categories with none are left out.
export const freeTickets = (
  mapping: typeof MappingJson.Type,
  availability: typeof AvailabilityJson.Type,
): ReadonlyMap<string, number> => {
  const categoryNames = new Map(mapping.priceCategories.map((category) => [category.id, category.name]))
  const free = new Map<string, number>()
  const add = (categoryId: number | undefined, count: number) => {
    const name = categoryId === undefined ? undefined : categoryNames.get(categoryId)
    if (name !== undefined && count > 0) free.set(name, (free.get(name) ?? 0) + count)
  }
  const categoryOf = new Map<number, number>()
  let id = 0
  let category = 0
  for (const [idDelta, , categoryDelta] of mapping.seats) {
    id += idDelta
    category += categoryDelta
    categoryOf.set(id, category)
  }
  id = 0
  for (const [idDelta, state] of availability.seats) {
    id += idDelta
    if (state === 1) add(categoryOf.get(id), 1)
  }
  const areaCategory = new Map((mapping.generalAdmissions ?? []).map(([area, , categoryId]) => [area, categoryId]))
  for (const [area, count] of availability.generalAdmissions ?? []) add(areaCategory.get(area), count)
  return free
}

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

// The site keeps the language for the session, cart and checkout included, and the selectors expect English.
const inEnglish = (url: URL) => {
  const english = new URL(url)
  english.searchParams.set("language", "en")
  return english.href
}

const openSeatingChart = (page: PageShape, url: URL) =>
  Effect.gen(function* () {
    yield* page.goto(inEnglish(url))
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

// Both …/event/<name>-<id>/ and the short …/event/<id>/, which redirects to it.
export const eventIdOf = (url: URL) => url.pathname.match(/\/event\/(?:[^/]*-)?(\d+)\/?$/)?.[1]

// The site signs these URLs with a timestamp and a signature, but the API answers without them.
const seatmapUrl = (kind: "mapping" | "availability", eventId: string) =>
  `https://public-api.eventim.com/seatmap/api/public/${kind}/web-20-${eventId}?a_systemId=3&a_promotionId=0&a_sessionId=FS8_NO_SESSION`

const ApiErrorJson = Schema.fromJsonString(Schema.Struct({ errorCode: Schema.String }))

export type ApiResult<A> = { readonly _tag: "Ok"; readonly value: A } | { readonly _tag: "NoSeatmap" }

// Plain HTTP without the browser: each answer is well under a kilobyte.
const seatmapApi = <S extends Schema.Top>(kind: "mapping" | "availability", eventId: string, schema: S) =>
  Effect.gen(function* () {
    const { status, text } = yield* HttpClient.get(seatmapUrl(kind, eventId), {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36" },
    }).pipe(
      Effect.flatMap((response) => Effect.map(response.text, (text) => ({ status: response.status, text }))),
      Effect.mapError((error) => new SeatsError({ message: `Eventim's ${kind} API did not answer: ${error.message}` })),
    )
    if (status === 403) return yield* new AccessDenied({ url: seatmapUrl(kind, eventId), status })
    if (status === 200) {
      const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
        Effect.mapError((error) => new SeatsError({ message: `Eventim's ${kind} API answered with an unexpected shape: ${error.message}` })),
      )
      return { _tag: "Ok", value } as ApiResult<S["Type"]>
    }
    // A sold-out event, or one sold without a seat map, has no seat map to serve.
    const code = yield* Schema.decodeUnknownEffect(ApiErrorJson)(text).pipe(Effect.option)
    if (status === 400 && code._tag === "Some" && code.value.errorCode === "400-SMS-061") return { _tag: "NoSeatmap" } as ApiResult<S["Type"]>
    return yield* new SeatsError({ message: `Eventim's ${kind} API answered HTTP ${status}: ${text.replace(/\s+/g, " ").slice(0, 160)}` })
  })

export const readMapping = (eventId: string) => seatmapApi("mapping", eventId, MappingJson)
export const readAvailability = (eventId: string) => seatmapApi("availability", eventId, AvailabilityJson)

// Akamai refuses a request it takes for a bot with a 403, and a page with its own "Access Denied" in place of the site's.
export class AccessDenied extends Data.TaggedError("AccessDenied")<{ readonly url: string; readonly status: number }> {
  get reason() {
    return this.status === 403 ? "HTTP 403" : "Access Denied page"
  }
  override get message() {
    return `blocked: ${this.reason} at ${this.url}`
  }
}

const refuseIfDenied = (page: PageShape) =>
  Effect.gen(function* () {
    const { status, denied } = yield* page.use("check for Access Denied", (raw) =>
      raw.evaluate<{ status: number; denied: boolean }>(
        `({ status: performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0, denied: document.title.trim() === "Access Denied" || (document.querySelector("h1")?.textContent ?? "").trim() === "Access Denied" })`,
      ),
    )
    if (status === 403 || denied) return yield* new AccessDenied({ url: yield* page.url, status })
  })

export const openEventPage = (page: PageShape, url: URL) =>
  Effect.gen(function* () {
    yield* page.goto(inEnglish(url))
    yield* refuseIfDenied(page)
    yield* declineConsent(page)
  })

type Category = { readonly index: number; readonly name: string; readonly typeIndex: number; readonly max: number; readonly price: number }

// Which category a cart attempt tries first; the rest follow as fallbacks.
export const CategoryOrder = { Cheapest: "cheapest", MostFree: "most-free" } as const
export type CategoryOrder = (typeof CategoryOrder)[keyof typeof CategoryOrder]

// The session cookie holds the cart, so a browser without Fnac's cookies starts a cart of its own.
export const cartCookies = /(^|\.)fnacspectacles\.com$/

export type Reserved = Cart & { readonly tickets: number }

const categoryForm = (index: number) => `[data-qa="price-category"] form >> nth=${index}`

// The cart renders its tickets after the page loads, and an error in their place often clears on a refresh.
const confirmCart = (page: PageShape, refreshes: number) =>
  Effect.gen(function* () {
    for (let refresh = 0; ; refresh++) {
      yield* refuseIfDenied(page)
      const shown = yield* page.use("wait for the tickets in the cart", (raw) =>
        raw.waitForFunction(`/Shopping Cart\\s+\\d+ tickets?,/.test(document.body.innerText)`, undefined, { timeout: 5_000 }).then(
          () => true,
          () => false,
        ),
      )
      if (shown) return
      if (refresh === refreshes)
        return yield* new SeatsError({ message: `the cart shows no tickets, even after ${refreshes} refresh(es), at ${yield* page.url}` })
      yield* Effect.logWarning(`The cart shows no tickets; refreshing it (${refresh + 1} of ${refreshes})`)
      yield* page.use("refresh the cart", (raw) => raw.reload())
    }
  })

// The ticket list beside the seat map sells the best seats left in a category, so no seat needs choosing.
export const addBestToCart = (url: URL, quantity: number, free: ReadonlyMap<string, number>, cartRefreshes: number, order: CategoryOrder) =>
  Page.use((page) =>
    Effect.gen(function* () {
      // The consent banner was answered when the tab first opened, and waiting for one that never shows costs 3 seconds;
      // a banner that does show fails the attempt, and the retry below reopens the page through openEventPage.
      yield* page.goto(inEnglish(url))
      yield* refuseIfDenied(page)
      const listed = yield* page.use("wait for the ticket categories", (raw) =>
        raw.locator('[data-qa="price-category"]').first().waitFor({ timeout: 20_000 }).then(
          () => true,
          () => false,
        ),
      )
      if (!listed) return yield* new SeatsError({ message: "the event page lists no ticket category for sale" })
      const categories = yield* page.use("read the ticket categories", (raw) =>
        raw.locator('[data-qa="price-category"] form').evaluateAll((forms): Array<Category> =>
          forms.map((form, index) => {
            const types = Array.from(form.querySelectorAll(".js-ticket-type-item"), (type) => type as typeof form)
            const buyable = (type: typeof form) => type.querySelector('[data-qa="more-tickets"]:not([disabled]):not(.disabled)') !== null
            // A marketing label marks a reduced rate, such as for members, that needs proof at the door.
            let typeIndex = types.findIndex((type) => !type.getAttribute("data-marketing-label-id") && buyable(type))
            if (typeIndex === -1) typeIndex = types.findIndex(buyable)
            const max = Number(types[typeIndex]?.querySelector(".js-stepper")?.getAttribute("data-max") ?? 0)
            // "€ 84.53" in English; a price that cannot be read sorts last.
            const shown = types[typeIndex]?.querySelector('[data-qa="tickettypeItem-price"]')?.textContent?.replace(/[^\d.,]/g, "").replace(",", ".") ?? ""
            const price = shown === "" ? Number.POSITIVE_INFINITY : Number(shown)
            return { index, name: (form.getAttribute("data-qa") ?? "").replace(/^pc-list-number-/, ""), typeIndex, max, price: Number.isNaN(price) ? Number.POSITIVE_INFINITY : price }
          }),
        ),
      )
      const candidates = categories
        .filter((category) => category.typeIndex !== -1 && category.max > 0)
        .sort((a, b) => {
          const byFree = (free.get(b.name) ?? 0) - (free.get(a.name) ?? 0)
          const byPrice = a.price - b.price
          return order === CategoryOrder.Cheapest ? byPrice || byFree : byFree || byPrice
        })
      if (candidates.length === 0) return yield* new SeatsError({ message: "no ticket category on the page can be bought" })

      const failures: Array<string> = []
      for (const category of candidates) {
        const known = free.get(category.name)
        const wanted = Math.max(1, Math.min(quantity, category.max, known ?? quantity))
        const type = `${categoryForm(category.index)} >> .js-ticket-type-item >> nth=${category.typeIndex}`
        const attempt = Effect.gen(function* () {
          yield* Effect.logInfo(`Choosing ${wanted} ticket(s) in ${category.name}`)
          for (let count = 0; count < wanted; count++) yield* click(page, `${type} >> [data-qa="more-tickets"]`, "h1")
          const chosen = Number(yield* page.locator(`${type} >> .js-stepper-amount-text`).first().innerText)
          if (!(chosen > 0)) return yield* new SeatsError({ message: `${category.name}: the stepper stayed at ${chosen}` })
          yield* Effect.logInfo(`Adding ${chosen} ticket(s) in ${category.name} to the cart`)
          // The form posts to the cart; a refused selection lands back on the event page instead.
          const landed = yield* Effect.forkChild(
            page.use("wait for the cart", (raw) => raw.waitForEvent("load", { timeout: 30_000 }).then(() => raw.url())),
          )
          yield* Effect.yieldNow
          yield* click(page, `${categoryForm(category.index)} >> [data-qa="add-to-shopping-cart"]`, "h1")
          if (new URL(yield* Fiber.join(landed)).pathname.includes("/event/"))
            return yield* new SeatsError({ message: "the site sent the selection back to the event page" })
          yield* confirmCart(page, cartRefreshes)
          return { url: yield* page.url, contents: `${chosen}× ${category.name}`, tickets: chosen } satisfies Reserved
        })
        const result = yield* Effect.result(attempt)
        if (result._tag === "Success") {
          yield* Effect.logInfo(`Tickets are in the cart at ${result.success.url}`)
          return result.success
        }
        // Another category would only meet the same refusal.
        if (result.failure._tag === "AccessDenied") return yield* result.failure
        failures.push(`${category.name}: ${result.failure.message}`)
        yield* Effect.logWarning(`Could not add ${category.name} to the cart: ${result.failure.message}`)
        yield* openEventPage(page, url)
      }
      return yield* new SeatsError({ message: `no category went into the cart (${failures.join("; ")})` })
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

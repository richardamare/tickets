import { Clock, Console, Effect } from "effect"
import { Browser, type BrowserShape, type PageShape, Page } from "./browser.ts"
import { type AccessDenied, addBestToCart, cartCookies, type CategoryOrder, eventIdOf, eventim, freeTickets, openEventPage, readAvailability, readMapping, type Reserved } from "./providers/eventim.ts"
import { type Cart, SeatsError } from "./seats.ts"
import { findExecutable, notify, notifyUntilClicked, runCommand } from "./notifications.ts"
import type { Listener } from "./listeners.ts"

type Check =
  | { readonly _tag: "Free"; readonly free: ReadonlyMap<string, number> }
  | { readonly _tag: "None"; readonly source: string }

const describe = (check: Check) =>
  check._tag === "None" ? `nothing free (${check.source})` : `free: ${[...check.free].map(([name, count]) => `${name} ×${count}`).join(", ")}`

const reveal = (page: PageShape, pid: number) =>
  page.use("bring browser to the front", (raw) => raw.bringToFront()).pipe(
    Effect.andThen(runCommand("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`])),
  )

const announceCart = (cart: Cart, page: PageShape, pid: number, group: string) =>
  Effect.gen(function* () {
    const notifier = yield* findExecutable("terminal-notifier")
    if (notifier !== undefined) {
      const clicked = yield* notifyUntilClicked(notifier, "Tickets in the cart", `${cart.contents}. Held about 15 minutes; click to open the browser and pay.`, group).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (clicked !== undefined) {
        if (clicked) yield* reveal(page, pid)
        return
      }
      yield* Effect.logWarning("terminal-notifier could not notify; allow its notifications in System Settings > Notifications")
    }
    yield* reveal(page, pid)
    yield* runCommand("afplay", ["/System/Library/Sounds/Glass.aiff"]).pipe(Effect.ignore)
  })

type Window = { readonly browser: BrowserShape; readonly page: PageShape }

export const restock = (
  url: string,
  options: { readonly quantity: number; readonly everySeconds: number; readonly cartRefreshes: number; readonly order: CategoryOrder },
  listener?: Listener,
) =>
  Effect.gen(function* () {
    const event = yield* Effect.try({ try: () => new URL(url), catch: () => new SeatsError({ message: `${url} is not a URL` }) })
    const eventId = eventIdOf(event)
    if (!eventim.matches(event) || eventId === undefined)
      return yield* new SeatsError({ message: `${url} is not a Fnac Spectacles event page (…/event/<id>/ or …/event/<name>-<id>/)` })

    const browser = yield* Browser
    const windows: Array<Window> = []
    let denied: AccessDenied | undefined
    // A blocked page is reloaded on the first hit anyway, so the API keeps being polled meanwhile.
    const ready = (next: BrowserShape) => Effect.gen(function* () {
      const page = yield* next.newPage
      windows.push({ browser: next, page })
      if (listener) yield* listener.update({ message: `Opening ${next.name} on the event page`, browserPids: windows.map((window) => window.browser.pid) })
      yield* Effect.logInfo("Opening the event page so the browser is ready to buy")
      const opened = yield* Effect.result(openEventPage(page, event))
      if (opened._tag === "Failure" && opened.failure._tag !== "AccessDenied") return yield* opened.failure
      denied = opened._tag === "Failure" && opened.failure._tag === "AccessDenied" ? opened.failure : undefined
      if (denied !== undefined) {
        yield* Console.error(`[${new Date(yield* Clock.currentTimeMillis).toISOString()}] event page ${denied.message}`)
        yield* notify("Restock blocked", denied.message)
      }
    })
    yield* ready(browser)

    let mapping = yield* readMapping(eventId).pipe(Effect.orElseSucceed(() => ({ _tag: "NoSeatmap" }) as const))
    const check = Effect.gen(function* () {
      if (mapping._tag === "NoSeatmap") mapping = yield* readMapping(eventId)
      if (mapping._tag === "NoSeatmap") return { _tag: "None", source: "no seat map" } as Check
      const availability = yield* readAvailability(eventId)
      if (availability._tag === "NoSeatmap") return { _tag: "None", source: "no seat map" } as Check
      const free = freeTickets(mapping.value, availability.value)
      return (free.size > 0 ? { _tag: "Free", free } : { _tag: "None", source: "seat map API" }) as Check
    })

    const stamp = Effect.map(Clock.currentTimeMillis, (now) => new Date(now).toISOString())
    yield* Console.log(`[${yield* stamp}] Watching ${event.href} every ${options.everySeconds}s for up to ${options.quantity} ticket(s)`)
    let last = ""
    let failures = 0
    const carts: Array<{ readonly reserved: Reserved; readonly window: Window }> = []
    const held = () => carts.reduce((total, { reserved }) => total + reserved.tickets, 0)
    const progress = () => carts.length === 0 ? "" : `${held()} of ${options.quantity} in ${carts.length} cart(s) · `
    let full = false
    while (!full) {
      const startedAt = yield* Clock.currentTimeMillis
      if (listener) yield* listener.update({ status: "checking", nextCheckAt: undefined })
      const result = yield* Effect.result(check)
      if (result._tag === "Failure") {
        failures++
        if (listener) yield* listener.update(result.failure._tag === "AccessDenied"
          ? { status: "blocked", message: `${result.failure.reason} from the API · check ${failures} failed`, lastCheckAt: yield* Clock.currentTimeMillis }
          : { status: "retrying", message: `Check failed (${failures}): ${result.failure.message}`, lastCheckAt: yield* Clock.currentTimeMillis })
        yield* Console.error(`[${yield* stamp}] check failed (${failures} in a row): ${result.failure.message}`)
        if (failures === 3) yield* notify("Restock check failing", `${event.href}: ${result.failure.message}`)
      } else {
        if (failures >= 3) yield* notify("Restock check working again", event.href)
        failures = 0
        const now = describe(result.success)
        // The API can answer while the site still blocks the browser, so a block shows until a cart attempt gets through.
        if (listener) yield* listener.update(denied !== undefined
          ? { status: "blocked", message: `${denied.reason} in the browser · ${progress()}${now}`, lastCheckAt: yield* Clock.currentTimeMillis }
          : { status: carts.length > 0 ? "in_cart" : "waiting", message: `${progress()}${now}`, lastCheckAt: yield* Clock.currentTimeMillis })
        if (now !== last) yield* Console.log(`[${yield* stamp}] ${now}`)
        last = now
        if (result.success._tag === "Free") {
          if (listener) yield* listener.update({ status: "carting", message: "Tickets available; adding to cart" })
          const window = windows.at(-1)!
          const bought = yield* Effect.result(addBestToCart(event, options.quantity - held(), result.success.free, options.cartRefreshes, options.order).pipe(Effect.provideService(Page, window.page)))
          if (bought._tag === "Success") {
            denied = undefined
            carts.push({ reserved: bought.success, window })
            full = held() >= options.quantity
            yield* Console.log(`[${yield* stamp}] IN THE CART ${carts.length}: ${bought.success.contents} at ${bought.success.url} (${held()} of ${options.quantity})`)
            if (listener) yield* listener.update({ status: "in_cart", message: `${progress()}pay in ${window.browser.name} before the hold expires` })
            // Each cart's hold runs out on its own, so each is announced the moment it fills.
            yield* announceCart(bought.success, window.page, window.browser.pid, `ticket-scraper-restock-${eventId}-${carts.length}`).pipe(Effect.ignore({ log: "Warn" }), Effect.forkScoped)
            if (full) break
            // The site caps how many tickets one cart takes, and a browser that shares the first one's cookies shares
            // its cart, so the rest go into another browser that starts without them.
            yield* Console.log(`[${yield* stamp}] opening another ${browser.name} for the remaining ${options.quantity - held()} ticket(s)`)
            const another = yield* Effect.result(Effect.gen(function* () {
              const next = yield* browser.openAnother
              yield* next.clearCookies(cartCookies)
              yield* ready(next)
            }))
            if (another._tag === "Failure") {
              yield* Console.error(`[${yield* stamp}] could not open another browser: ${another.failure.message}`)
              yield* notify("Restock stopped short", `${held()} of ${options.quantity} tickets in the cart; no browser for the rest: ${another.failure.message}`)
              break
            }
            continue
          } else {
            if (bought.failure._tag === "AccessDenied" && denied === undefined) yield* notify("Restock blocked", bought.failure.message)
            denied = bought.failure._tag === "AccessDenied" ? bought.failure : undefined
            if (listener) yield* listener.update(denied === undefined
              ? { status: "retrying", message: `Could not fill the cart: ${bought.failure.message}` }
              : { status: "blocked", message: `${denied.reason} in the browser · could not fill the cart` })
            yield* Console.error(`[${yield* stamp}] could not fill the cart: ${bought.failure.message}`)
            last = ""
          }
        }
      }
      const nextCheckAt = Math.max(yield* Clock.currentTimeMillis, startedAt + options.everySeconds * 1000)
      if (listener) yield* listener.update({ nextCheckAt })
      yield* Effect.sleep(Math.max(0, nextCheckAt - (yield* Clock.currentTimeMillis)))
    }

    const cartBrowsers = carts.map(({ window }) => window.browser)
    if (listener) yield* listener.update({ status: "in_cart", message: `${progress()}pay in each ${browser.name} window before its hold expires`, nextCheckAt: undefined })
    yield* Console.log(`Pay in each ${browser.name} window before its hold runs out; closing every one of them ends this command.`)
    yield* Effect.forEach(cartBrowsers, (cartBrowser) => cartBrowser.untilClosed, { concurrency: "unbounded", discard: true })
  })

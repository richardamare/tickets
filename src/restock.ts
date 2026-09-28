import { Clock, Console, Effect } from "effect"
import { Browser, type PageShape, Page } from "./browser.ts"
import { type AccessDenied, addBestToCart, eventIdOf, eventim, freeTickets, openEventPage, readAvailability, readMapping } from "./providers/eventim.ts"
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

export const restock = (url: string, options: { readonly quantity: number; readonly everySeconds: number; readonly cartRefreshes: number }, listener?: Listener) =>
  Effect.gen(function* () {
    const event = yield* Effect.try({ try: () => new URL(url), catch: () => new SeatsError({ message: `${url} is not a URL` }) })
    const eventId = eventIdOf(event)
    if (!eventim.matches(event) || eventId === undefined)
      return yield* new SeatsError({ message: `${url} is not a Fnac Spectacles event page (…/event/<id>/ or …/event/<name>-<id>/)` })

    const browser = yield* Browser
    const page: PageShape = yield* browser.newPage
    if (listener) yield* listener.update({ message: `Opening ${browser.name} on the event page`, browserPid: browser.pid })
    yield* Effect.logInfo("Opening the event page so the browser is ready to buy")
    // A blocked page is reloaded on the first hit anyway, so the API keeps being polled meanwhile.
    const opened = yield* Effect.result(openEventPage(page, event))
    if (opened._tag === "Failure" && opened.failure._tag !== "AccessDenied") return yield* opened.failure
    let denied: AccessDenied | undefined = opened._tag === "Failure" && opened.failure._tag === "AccessDenied" ? opened.failure : undefined
    if (denied !== undefined) {
      yield* Console.error(`[${new Date(yield* Clock.currentTimeMillis).toISOString()}] event page ${denied.message}`)
      yield* notify("Restock blocked", denied.message)
    }

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
    let cart: Cart | undefined
    while (cart === undefined) {
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
        if (listener) yield* listener.update(denied === undefined ? { status: "waiting", message: now, lastCheckAt: yield* Clock.currentTimeMillis } : { status: "blocked", message: `${denied.reason} in the browser · ${now}`, lastCheckAt: yield* Clock.currentTimeMillis })
        if (now !== last) yield* Console.log(`[${yield* stamp}] ${now}`)
        last = now
        if (result.success._tag === "Free") {
          if (listener) yield* listener.update({ status: "carting", message: "Tickets available; adding to cart" })
          const bought = yield* Effect.result(addBestToCart(event, options.quantity, result.success.free, options.cartRefreshes).pipe(Effect.provideService(Page, page)))
          if (bought._tag === "Success") cart = bought.success
          else {
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
      if (cart !== undefined) break
      const nextCheckAt = Math.max(yield* Clock.currentTimeMillis, startedAt + options.everySeconds * 1000)
      if (listener) yield* listener.update({ nextCheckAt })
      yield* Effect.sleep(Math.max(0, nextCheckAt - (yield* Clock.currentTimeMillis)))
    }

    if (listener) yield* listener.update({ status: "in_cart", message: `${cart.contents} — pay in ${browser.name} before the hold expires`, nextCheckAt: undefined })
    yield* Console.log(`[${yield* stamp}] IN THE CART: ${cart.contents} at ${cart.url}`)
    yield* Console.log(`Pay in the ${browser.name} window before the hold runs out; closing that window ends this command.`)
    // The notification waits for its click only while the cart's browser is open.
    yield* Effect.raceFirst(
      announceCart(cart, page, browser.pid, `ticket-scraper-restock-${eventId}`).pipe(Effect.ignore({ log: "Warn" }), Effect.andThen(Effect.never)),
      browser.untilClosed,
    )
  })

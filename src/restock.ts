import { Clock, Console, Effect, Random } from "effect"
import { Browser, type PageShape, Page } from "./browser.ts"
import { addBestToCart, eventIdOf, eventim, freeTickets, openEventPage, pageOffersTickets, readAvailability, readMapping } from "./providers/eventim.ts"
import { type Cart, SeatsError } from "./seats.ts"
import { notify } from "./watch.ts"

type Check =
  | { readonly _tag: "Free"; readonly free: ReadonlyMap<string, number> }
  | { readonly _tag: "None"; readonly source: string }

const describe = (check: Check) =>
  check._tag === "None"
    ? `nothing free (${check.source})`
    : check.free.size === 0
      ? "tickets on sale (event page)"
      : `free: ${[...check.free].map(([name, count]) => `${name} ×${count}`).join(", ")}`

// CDP picks the tab; System Events raises this Edge by pid, where `open -a` would pick the everyday Edge.
const reveal = (page: PageShape, pid: number) =>
  page.use("bring Edge to the front", async (raw) => {
    await raw.bringToFront()
    await Bun.$`osascript -e ${`tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`}`.quiet()
  })

// terminal-notifier waits for the answer: "Open" or @ACTIONCLICKED for a click and @CLOSED for a dismissal, all
// with exit 0; any other exit means it could not notify. The notification is removed once nobody waits for it,
// since clicking one whose sender has exited only gets an error from macOS.
const notifyUntilClicked = (notifier: string, title: string, message: string, group: string) =>
  Effect.callback<boolean | undefined>((resume) => {
    const child = Bun.spawn([notifier, "-title", title, "-message", message, "-sound", "default", "-group", group, "-action", "Open"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    void child.exited.then(async (code) => {
      const answer = (await new Response(child.stdout).text()).trim()
      resume(Effect.succeed(code === 0 ? answer !== "@CLOSED" : undefined))
    })
    return Effect.sync(() => child.kill())
  }).pipe(Effect.ensuring(Effect.sync(() => Bun.spawnSync([notifier, "-remove", group]))))

const announceCart = (cart: Cart, page: PageShape, pid: number, group: string) =>
  Effect.gen(function* () {
    const notifier = Bun.which("terminal-notifier")
    if (notifier !== null) {
      const clicked = yield* notifyUntilClicked(notifier, "Tickets in the cart", `${cart.contents}. Held about 15 minutes; click to open Edge and pay.`, group)
      if (clicked !== undefined) {
        if (clicked) yield* reveal(page, pid)
        return
      }
      yield* Effect.logWarning("terminal-notifier could not notify; allow its notifications in System Settings > Notifications")
    }
    // An osascript notification opens Script Editor over Edge, so Edge comes to the front with a sound instead.
    yield* reveal(page, pid)
    yield* Effect.tryPromise(() => Bun.$`afplay /System/Library/Sounds/Glass.aiff`.quiet()).pipe(Effect.ignore)
  })

export const restock = (url: string, options: { readonly quantity: number; readonly everySeconds: number; readonly cartRefreshes: number }) =>
  Effect.gen(function* () {
    const event = yield* Effect.try({ try: () => new URL(url), catch: () => new SeatsError({ message: `${url} is not a URL` }) })
    const eventId = eventIdOf(event)
    if (!eventim.matches(event) || eventId === undefined)
      return yield* new SeatsError({ message: `${url} is not a Fnac Spectacles event page (…/event/<name>-<id>/)` })

    const browser = yield* Browser
    const page: PageShape = yield* browser.newPage
    yield* Effect.logInfo("Opening the event page so the browser is ready to buy")
    yield* openEventPage(page, event)

    let mapping = yield* readMapping(eventId)
    const check = Effect.gen(function* () {
      if (mapping._tag === "NoSeatmap") mapping = yield* readMapping(eventId)
      if (mapping._tag === "Ok") {
        const availability = yield* readAvailability(eventId)
        if (availability._tag === "Ok") {
          const free = freeTickets(mapping.value, availability.value)
          return (free.size > 0 ? { _tag: "Free", free } : { _tag: "None", source: "seat map API" }) as Check
        }
      }
      const onSale = yield* pageOffersTickets(page, event)
      return (onSale ? { _tag: "Free", free: new Map() } : { _tag: "None", source: "event page" }) as Check
    })

    const stamp = Effect.map(Clock.currentTimeMillis, (now) => new Date(now).toISOString())
    yield* Console.log(`[${yield* stamp}] Watching ${event.href} every ~${options.everySeconds}s for up to ${options.quantity} ticket(s)`)
    let last = ""
    let failures = 0
    let cart: Cart | undefined
    while (cart === undefined) {
      const result = yield* Effect.result(check)
      if (result._tag === "Failure") {
        failures++
        yield* Console.error(`[${yield* stamp}] check failed (${failures} in a row): ${result.failure.message}`)
        if (failures === 3) yield* notify("Restock check failing", `${event.href}: ${result.failure.message}`)
      } else {
        if (failures >= 3) yield* notify("Restock check working again", event.href)
        failures = 0
        const now = describe(result.success)
        if (now !== last) yield* Console.log(`[${yield* stamp}] ${now}`)
        last = now
        if (result.success._tag === "Free") {
          const bought = yield* Effect.result(addBestToCart(event, options.quantity, result.success.free, options.cartRefreshes).pipe(Effect.provideService(Page, page)))
          if (bought._tag === "Success") cart = bought.success
          else {
            yield* Console.error(`[${yield* stamp}] could not fill the cart: ${bought.failure.message}`)
            last = ""
          }
        }
      }
      if (cart !== undefined) break
      // Repeated failures slow the checks down, up to two minutes, in case the site is pushing back.
      const base = Math.min(120, options.everySeconds * 2 ** Math.min(failures, 4))
      const jitter = yield* Random.nextBetween(0.8, 1.2)
      yield* Effect.sleep(`${Math.round(base * jitter * 1000)} millis`)
    }

    yield* Console.log(`[${yield* stamp}] IN THE CART: ${cart.contents} at ${cart.url}`)
    yield* Console.log("Pay in the Edge window before the hold runs out; closing that window ends this command.")
    // The notification waits for its click only while the cart's Edge is open.
    yield* Effect.raceFirst(
      announceCart(cart, page, browser.pid, `ticket-scraper-restock-${eventId}`).pipe(Effect.ignore({ log: "Warn" }), Effect.andThen(Effect.never)),
      browser.untilClosed,
    )
  })

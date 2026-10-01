import { mock } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Context, Effect } from "effect"

const asked: number[] = []
const cleared: string[] = []
const orders: string[] = []
let opened = 0
class Page extends Context.Service<Page, {}>()("CartsTestPage") {}
class Browser extends Context.Service<Browser, {}>()("CartsTestBrowser") {}
const makeBrowser = (pid: number) => ({
  pid, name: "Chrome", newPage: Effect.succeed({}), untilClosed: Effect.void,
  clearCookies: (domain: RegExp) => Effect.sync(() => { cleared.push(`${pid}:${domain.source}`) }),
})
mock.module("../browser.ts", () => ({ Page, Browser }))
mock.module("../notifications.ts", () => ({
  findExecutable: () => Effect.succeed(undefined), notify: () => Effect.void,
  notifyUntilClicked: () => Effect.succeed(false), runCommand: () => Effect.void,
}))
mock.module("../providers/eventim.ts", () => ({
  eventIdOf: () => "123", eventim: { matches: () => true }, cartCookies: /fnac/,
  openEventPage: () => Effect.void, pageOffersTickets: () => Effect.succeed(false),
  readMapping: () => Effect.succeed({ _tag: "Ok", value: {} }),
  readAvailability: () => Effect.succeed({ _tag: "Ok", value: {} }),
  freeTickets: () => new Map([["Catégorie 1", 40]]),
  // The site takes at most 5 tickets per cart.
  addBestToCart: (_url: URL, quantity: number, _free: unknown, _refreshes: number, order: string) => Effect.sync(() => {
    asked.push(quantity)
    orders.push(order)
    const tickets = Math.min(5, quantity)
    return { url: "https://example.test/cart", contents: `${tickets}× Catégorie 1`, tickets }
  }),
}))
const { restock } = await import("../restock.ts")
await Effect.runPromise(restock("https://fnacspectacles.com/event/show-123/", { everySeconds: 0.5, quantity: 12, cartRefreshes: 0, order: "cheapest" }).pipe(
  Effect.provideService(Browser, { ...makeBrowser(100), openAnother: Effect.sync(() => makeBrowser(101 + opened++)) } as never),
  Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(BunServices.layer),
) as Effect.Effect<void, unknown>)
const expect = (label: string, actual: unknown, wanted: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`)
}
expect("tickets asked of each cart", asked, [12, 7, 2])
expect("extra browsers opened", opened, 2)
expect("cookies cleared in each extra browser", cleared, ["101:fnac", "102:fnac"])
expect("category order passed on", [...new Set(orders)], ["cheapest"])

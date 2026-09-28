import { mock } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Clock, ConfigProvider, Context, Effect, FileSystem, Layer, Path } from "effect"

const starts: number[] = []
const observe = Effect.gen(function* () {
  starts.push(yield* Clock.currentTimeMillis)
  if (starts.length === 3) return yield* Effect.interrupt
  yield* Effect.sleep("100 millis")
})
class Page extends Context.Service<Page, {}>()("PollingTestPage") {
  static readonly layer = Layer.succeed(Page, {})
}
class Browser extends Context.Service<Browser, { newPage: Effect.Effect<{}>; name: string }>()("PollingTestBrowser") {}
mock.module("../browser.ts", () => ({ Page, Browser }))
mock.module("../providers/eventim.ts", () => ({
  eventIdOf: () => "123", eventim: { matches: () => true },
  openEventPage: () => Effect.void,
  readMapping: () => Effect.succeed({ _tag: "Ok", value: { priceCategories: [] } }),
  readAvailability: () => observe.pipe(Effect.as({ _tag: "Ok", value: {} })),
  freeTickets: () => new Map(), cartCookies: /x/,
  addBestToCart: () => Effect.die("No tickets should be reserved"),
}))
const { watch } = await import("../watch.ts")
const { restock } = await import("../restock.ts")
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "polling-cadence-" })
  const run: Effect.Effect<void, unknown, unknown> = process.argv[2] === "watch"
    ? watch(["https://fnacspectacles.com/event/show-123/"], { everySeconds: 0.5, once: false, until: [] })
    : restock("https://fnacspectacles.com/event/show-123/", { everySeconds: 0.5, quantity: 1, cartRefreshes: 0, order: "cheapest" })
  yield* run.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ HOME: dir, WATCH_STATE_FILE: path.join(dir, "watch.json") })),
    Effect.provideService(Browser, { newPage: Effect.succeed({}), name: "Chrome" }),
    Effect.timeout("3 seconds"), Effect.exit,
  )
  if (starts.length !== 3) throw new Error(`Expected 3 checks, got ${starts.length}`)
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i]! - starts[i - 1]!
    if (gap < 470 || gap > 580) throw new Error(`Expected 500ms cadence including 100ms check, got ${gap}ms`)
  }
})).pipe(Effect.provide(BunServices.layer)) as Effect.Effect<void, unknown>)

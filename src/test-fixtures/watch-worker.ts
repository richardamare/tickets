import { mock } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Config, ConfigProvider, Effect, FileSystem, Path } from "effect"

mock.module("../providers/eventim.ts", () => ({
  eventIdOf: (url: URL) => url.pathname.match(/-(\d+)\/?$/)?.[1],
  eventim: { matches: () => true },
  readMapping: () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (breakPersistence) yield* fs.writeFileString(blockedDirectory, "blocks state persistence")
    else {
      checks++
      if (checks === 2) ready()
      yield* Effect.promise(() => bothChecked)
    }
    return { _tag: "NoSeatmap" }
  }),
  readAvailability: () => Effect.die("A check without a seat map reads no availability"),
  freeTickets: () => new Map(),
}))
let blockedDirectory = ""
let breakPersistence = false
let checks = 0
let ready: () => void
const bothChecked = new Promise<void>((resolve) => { ready = resolve })
const { watch } = await import("../watch.ts")
const { makeListenerRegistry, withListeners } = await import("../listeners.ts")
const { makeWatchState } = await import("../watch-state.ts")

const probe = Effect.scoped(Effect.gen(function* () {
  const mode = yield* Config.String("TICKET_TEST_WATCH_MODE")
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "watch-completion-test-" })
  const file = path.join(dir, "watch.json")
  blockedDirectory = `${file}.d`
  const listeners = path.join(dir, "listeners")
  const input = { kind: "watch" as const, url: "https://www.fnacspectacles.com/event/concert-1/", profile: "default", everySeconds: 300 }
  const config = ConfigProvider.fromUnknown({ HOME: dir, WATCH_STATE_FILE: file })
  const options = { everySeconds: 0.5, once: true, until: [] }
  if (mode === "concurrent") {
    yield* Effect.gen(function* () {
      yield* Effect.all([watch(["https://www.fnacspectacles.com/event/one-1/"], options), watch(["https://www.fnacspectacles.com/event/two-2/"], options)], { concurrency: 2 })
      const state = yield* makeWatchState({ browser: "chrome", profileKey: "default" })
      for (const url of ["https://www.fnacspectacles.com/event/one-1/", "https://www.fnacspectacles.com/event/two-2/"]) {
        if ((yield* state.load(url)).lastGood?.status !== "sold_out") throw new Error(`Lost state for ${url}`)
      }
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config))
    return
  }
  breakPersistence = true
  const result = yield* Effect.result(withListeners([input], (handles) => watch([input.url], options, handles), listeners).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, config),
  ))
  const registry = yield* makeListenerRegistry(listeners)
  const row = (yield* registry.read)[0]!
  if (result._tag !== "Failure" || row.status !== "failed") throw new Error(`Persistence failure was reported as ${row.status}`)
  const outcome = yield* registry.readRunOutcome(row.runId!)
  if (outcome._tag !== "Some" || outcome.value.status !== "failed") throw new Error("Failure was not acknowledged")
})).pipe(Effect.provide(BunServices.layer))
// The seat map API is replaced by this process's module mock.
await Effect.runPromise(probe as Effect.Effect<void, unknown>)

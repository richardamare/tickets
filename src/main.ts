import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { attempt, Browser } from "./browser.ts"

const url = Argument.String("url").pipe(Argument.withDescription("Page to open"))

const scraper = Command.make("ticket-scraper", { url }, ({ url }) =>
  Effect.gen(function* () {
    const browser = yield* Browser
    const page = yield* browser.newPage
    yield* attempt(`load ${url}`, () => page.goto(url))
    yield* Console.log(yield* attempt("read title", () => page.title()))
    yield* Effect.sleep("30 seconds")
  }).pipe(Effect.scoped, Effect.provide(Browser.layer({ headless: false }))),
).pipe(Command.withDescription("Print the title of the page at <url>"))

// bun run sets npm_package_version from package.json; running the file directly does not.
const version = Config.NonEmptyString("npm_package_version").pipe(Config.withDefault("unknown"))

// runMain interrupts on SIGINT and SIGTERM only; without this, SIGHUP skips the finalizers that close the browser.
const hangup = Effect.callback<never>((resume) => {
  const onHangup = () => resume(Effect.interrupt)
  process.once("SIGHUP", onHangup)
  return Effect.sync(() => process.off("SIGHUP", onHangup))
})

Effect.gen(function* () {
  yield* Command.run(scraper, { version: yield* version })
}).pipe(Effect.raceFirst(hangup), Effect.provide(BunServices.layer), BunRuntime.runMain)

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { Browser } from "./browser.ts"

const url = Argument.String("url").pipe(Argument.withDescription("Page to open"))

const scraper = Command.make("ticket-scraper", { url }, ({ url }) =>
  Effect.gen(function* () {
    const browser = yield* Browser
    const title = yield* browser.withPage(`load ${url}`, async (page) => {
      await page.goto(url)
      return page.title()
    })
    yield* Console.log(title)
  }).pipe(Effect.provide(Browser.layer())),
).pipe(Command.withDescription("Print the title of the page at <url>"))

// bun run sets npm_package_version from package.json; running the file directly does not.
const version = Config.NonEmptyString("npm_package_version").pipe(Config.withDefault("unknown"))

Effect.gen(function* () {
  yield* Command.run(scraper, { version: yield* version })
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)

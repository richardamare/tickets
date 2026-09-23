import { Console, Effect } from "effect"
import { Browser } from "./browser.ts"

const program = (url: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser
    const title = yield* browser.withPage(`load ${url}`, async (page) => {
      await page.goto(url)
      return page.title()
    })
    yield* Console.log(title)
  })

const url = process.argv[2]

if (url === undefined) {
  console.error("Usage: bun run start <url>")
  process.exitCode = 1
} else {
  await Effect.runPromise(program(url).pipe(Effect.provide(Browser.layer())))
}

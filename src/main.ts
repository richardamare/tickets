import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { runAgent } from "./agent.ts"
import { Browser, Page } from "./browser.ts"
import { Foundry } from "./foundry.ts"
import { Secrets } from "./secrets.ts"
import { AgentState } from "./state.ts"

const StateJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

const PageLive = Page.layer.pipe(Layer.provide(Browser.layer({ headless: false })))

const title = Command.make(
  "title",
  { url: Argument.String("url").pipe(Argument.withDescription("Page to open")) },
  ({ url }) =>
    Page.use((page) =>
      Effect.gen(function* () {
        yield* page.goto(url)
        yield* Console.log(yield* page.title)
        yield* Effect.sleep("30 seconds")
      }),
    ).pipe(Effect.provide(PageLive)),
).pipe(Command.withDescription("Print the title of the page at <url>, then keep it open for 30 seconds"))

const agent = Command.make(
  "agent",
  {
    task: Argument.String("task").pipe(Argument.withDescription("What the agent should find out, in plain language")),
    maxSteps: Flag.Int("max-steps").pipe(Flag.withDescription("Model calls before giving up"), Flag.withDefault(25)),
  },
  ({ task, maxSteps }) =>
    runAgent(task, { maxSteps }).pipe(
      Effect.flatMap(({ answer, state }) =>
        Effect.gen(function* () {
          yield* Console.log(answer)
          yield* Console.error(`[state] ${yield* Schema.encodeEffect(StateJson)(state)}`)
        }),
      ),
      Effect.provide(Layer.mergeAll(PageLive, Foundry.layer, AgentState.layer, Secrets.layer)),
    ),
).pipe(Command.withDescription("Let the model drive the browser to answer <task>"))

const scraper = Command.make("ticket-scraper").pipe(Command.withSubcommands([title, agent]))

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

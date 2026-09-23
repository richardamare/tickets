import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { runAgent } from "./agent.ts"
import { Browser, Page } from "./browser.ts"
import { Foundry } from "./foundry.ts"
import { Secrets } from "./secrets.ts"
import { AgentState } from "./state.ts"
import { statuses, watch } from "./watch.ts"

const StateJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

const PageLive = Page.layer.pipe(Layer.provide(Browser.layer))

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

const watchCommand = Command.make(
  "watch",
  {
    urls: Argument.String("url").pipe(Argument.withDescription("Event pages to monitor"), Argument.atLeast(1)),
    every: Flag.Int("every").pipe(
      Flag.withDescription("Minutes between rounds of checks (at least 5)"),
      Flag.withDefault(15),
      Flag.filter(
        (minutes) => minutes >= 5,
        (minutes) => `--every ${minutes} is below the 5 minute minimum`,
      ),
    ),
    once: Flag.Boolean("once").pipe(Flag.withDescription("Run one round of checks and exit"), Flag.withDefault(false)),
    maxSteps: Flag.Int("max-steps").pipe(Flag.withDescription("Model calls per check before giving up"), Flag.withDefault(25)),
    until: Flag.Literals("until", statuses).pipe(
      Flag.withDescription("Stop watching a page once its status is this one; repeat for several"),
      Flag.atLeast(0),
    ),
  },
  ({ urls, every, once, maxSteps, until }) =>
    watch(urls, { everyMinutes: every, once, maxSteps, until }).pipe(
      Effect.provide(Layer.mergeAll(Browser.layer, Foundry.layer, Secrets.layer)),
    ),
).pipe(Command.withDescription("Check ticket availability on <url>... and report every change, until each page reaches an --until status"))

const scraper = Command.make("ticket-scraper").pipe(Command.withSubcommands([title, agent, watchCommand]))

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

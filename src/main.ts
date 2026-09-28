import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { runAgent } from "./agent.ts"
import { Browser, Page, ProfileFlag, setupProfile } from "./browser.ts"
import { Foundry } from "./foundry.ts"
import { eventim } from "./providers/eventim.ts"
import { restock } from "./restock.ts"
import { describeSeats, SeatProviders, SeatsJson } from "./seats.ts"
import { Secrets } from "./secrets.ts"
import { AgentState } from "./state.ts"
import { statuses, watch } from "./watch.ts"

const StateJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

const PageLive = Page.layer.pipe(Layer.provide(Browser.layer))
const SeatProvidersLive = SeatProviders.layer([eventim])

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
      Effect.provide(Layer.mergeAll(PageLive, Foundry.layer, AgentState.layer, Secrets.layer, SeatProvidersLive)),
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
      Effect.provide(Layer.mergeAll(Browser.layer, Foundry.layer, Secrets.layer, SeatProvidersLive)),
    ),
).pipe(Command.withDescription("Check ticket availability on <url>... and report every change, until each page reaches an --until status"))

const seats = Command.make(
  "seats",
  {
    url: Argument.String("url").pipe(Argument.withDescription("Event page with a seating chart")),
    json: Flag.Boolean("json").pipe(Flag.withDescription("Print every seat as JSON"), Flag.withDefault(false)),
  },
  ({ url, json }) =>
    SeatProviders.use((providers) => providers.providerFor(url)).pipe(
      Effect.flatMap(({ provider, url }) => provider.read(url).pipe(Effect.provide(PageLive))),
      Effect.flatMap((seats) => (json ? Schema.encodeEffect(SeatsJson)(seats) : Effect.succeed(describeSeats(seats)))),
      Effect.flatMap(Console.log),
      Effect.provide(SeatProvidersLive),
    ),
).pipe(Command.withDescription("Read the seating chart of <url> and list the free seats"))

const restockCommand = Command.make(
  "restock",
  {
    url: Argument.String("url").pipe(Argument.withDescription("Fnac Spectacles event page to watch")),
    quantity: Flag.Int("quantity").pipe(
      Flag.withDescription("Most tickets to put in the cart; fewer when fewer are left"),
      Flag.withDefault(1),
      Flag.filter(
        (count) => count >= 1,
        (count) => `--quantity ${count} is below 1`,
      ),
    ),
    every: Flag.Int("every").pipe(
      Flag.withDescription("Seconds between checks (at least 5)"),
      Flag.withDefault(10),
      Flag.filter(
        (seconds) => seconds >= 5,
        (seconds) => `--every ${seconds} is below the 5 second minimum`,
      ),
    ),
    cartRefreshes: Flag.Int("cart-refreshes").pipe(
      Flag.withDescription("Times to refresh a cart that shows no tickets before trying the next category"),
      Flag.withDefault(2),
      Flag.filter(
        (count) => count >= 0,
        (count) => `--cart-refreshes ${count} is below 0`,
      ),
    ),
  },
  ({ url, quantity, every, cartRefreshes }) =>
    restock(url, { quantity, everySeconds: every, cartRefreshes }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(Browser.layer, FetchHttpClient.layer))),
).pipe(
  Command.withDescription(
    "Poll Eventim's availability API for <url> and, as soon as tickets are free, put up to --quantity of them in the cart in a ready Edge, then notify you and stop",
  ),
)

const profile = Command.make(
  "profile",
  { name: Argument.String("name").pipe(Argument.withDescription("Name of the account, used later as --profile <name>")) },
  ({ name }) => setupProfile(name),
).pipe(
  Command.withDescription(
    "Open Edge on the saved profile <name>, empty the first time, for you to sign in; the profile is saved when you close the window",
  ),
)

const scraper = Command.make("ticket-scraper").pipe(
  Command.withSubcommands([title, agent, watchCommand, restockCommand, seats, profile]),
  Command.withGlobalFlags([ProfileFlag]),
)

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

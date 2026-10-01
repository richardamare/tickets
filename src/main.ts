#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { runAgent } from "./agent.ts"
import { Browser, BrowserFlag, Page, ProfileFlag, setupProfile } from "./browser.ts"
import { makeBrowserProfiles } from "./browser-config.ts"
import { CheckInterval, TicketQuantity, RestockUrl, defaults } from "./listener-request.ts"
import { Foundry } from "./foundry.ts"
import { eventim } from "./providers/eventim.ts"
import { restock } from "./restock.ts"
import { describeSeats, SeatProviders, SeatsJson } from "./seats.ts"
import { Secrets } from "./secrets.ts"
import { AgentState } from "./state.ts"
import { statuses, watch } from "./watch.ts"
import { withListeners } from "./listeners.ts"
import { dashboard } from "./tui.ts"

const StateJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

const PageLive = Page.layer.pipe(Layer.provide(Browser.layer))
const SeatProvidersLive = SeatProviders.layer([eventim])
const selectedBrowser = Effect.gen(function* () {
  const profiles = yield* makeBrowserProfiles()
  return yield* profiles.resolveSelection(Option.getOrUndefined(yield* BrowserFlag), Option.getOrUndefined(yield* ProfileFlag))
})

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
    urls: Argument.String("url").pipe(Argument.withDescription("Fnac Spectacles event pages to monitor"), Argument.atLeast(1)),
    every: Flag.Finite("every").pipe(
      Flag.withDescription("Seconds between rounds of checks (at least 0.5)"),
      Flag.withDefault(defaults.watchEvery),
      Flag.filter(
        Schema.is(CheckInterval),
        () => "--every must be a number from 0.5 to 1000000 seconds",
      ),
    ),
    once: Flag.Boolean("once").pipe(Flag.withDescription("Run one round of checks and exit"), Flag.withDefault(false)),
    until: Flag.Literals("until", statuses).pipe(
      Flag.withDescription("Stop watching a page once its status is this one; repeat for several"),
      Flag.atLeast(0),
    ),
  },
  ({ urls, every, once, until }) =>
    Effect.gen(function* () {
      for (const url of urls) yield* Schema.decodeUnknownEffect(RestockUrl)(url)
      const selection = yield* selectedBrowser
      const { browser, profile } = selection
      const profileKey = profile === "default" ? "default" : `named:${profile}`
      return yield* withListeners(
        [...new Set(urls)].map((url) => ({ kind: "watch", url, browser, profile, profileKey, everySeconds: every })),
        (listeners) => watch(urls, { everySeconds: every, once, until, browser, profileKey }, listeners).pipe(
          Effect.provide(FetchHttpClient.layer),
        ),
      )
    }),
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
      Flag.withDefault(defaults.quantity),
      Flag.filter(
        Schema.is(TicketQuantity),
        () => "--quantity must be a whole number from 1 to 100",
      ),
    ),
    every: Flag.Finite("every").pipe(
      Flag.withDescription("Seconds between checks (at least 0.5)"),
      Flag.withDefault(defaults.restockEvery),
      Flag.filter(
        Schema.is(CheckInterval),
        () => "--every must be a number from 0.5 to 1000000 seconds",
      ),
    ),
    prefer: Flag.Literals("prefer", ["cheapest", "most-free"]).pipe(
      Flag.withDescription("Category to try first: the cheapest, or the one with the most free tickets"),
      Flag.withDefault(defaults.prefer),
    ),
    tabs: Flag.Int("tabs").pipe(
      Flag.withDescription("Tabs that each try a different category at the same time on a hit"),
      Flag.withDefault(3),
      Flag.filter(
        (count) => count >= 1 && count <= 8,
        (count) => `--tabs ${count} is outside 1 to 8`,
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
  ({ url, quantity, every, prefer, cartRefreshes, tabs }) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(RestockUrl)(url)
      const selection = yield* selectedBrowser
      const { browser, profile } = selection
      const profileKey = profile === "default" ? "default" : `named:${profile}`
      return yield* withListeners(
        [{ kind: "restock", url, browser, profile, profileKey, everySeconds: every }],
        ([listener]) => restock(url, { quantity, everySeconds: every, cartRefreshes, order: prefer, tabs }, listener).pipe(
          Effect.scoped, Effect.provide(Layer.mergeAll(Browser.layerFor(selection), FetchHttpClient.layer)),
        ),
      )
    }),
).pipe(
  Command.withDescription(
    "Poll Eventim availability and reserve up to --quantity tickets in the selected browser; notify you to pay manually",
  ),
)

const profile = Command.make(
  "profile",
  { name: Argument.String("name").pipe(Argument.withDescription("Name of the account, used later as --profile <name>")) },
  ({ name }) => Effect.flatMap(BrowserFlag, (browser) => setupProfile(name, Option.getOrUndefined(browser))),
).pipe(
  Command.withDescription(
    "Open a reusable source profile to sign in; close the setup window to save it as your default",
  ),
)

const tui = Command.make("tui", {}, () => dashboard).pipe(
  Command.withDescription("Show all watch and restock listeners with live status and keyboard shortcuts"),
)

const scraper = Command.make("tickets", {}, () => dashboard).pipe(
  Command.withSubcommands([title, agent, watchCommand, restockCommand, seats, profile, tui]),
  Command.withGlobalFlags([ProfileFlag, BrowserFlag]),
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

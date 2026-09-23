import { Context, Data, Effect, Layer, Option, type Scope } from "effect"
import { chromium, type LaunchOptions, type Locator as PlaywrightLocator, type Page as PlaywrightPage } from "playwright"

export class BrowserError extends Data.TaggedError("BrowserError")<{
  readonly operation: string
  readonly cause: unknown
}> {
  override get message() {
    return `Browser ${this.operation} failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

const attempt = <A>(operation: string, f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new BrowserError({ operation, cause }) })

type RoleOptions = Parameters<PlaywrightPage["getByRole"]>[1]
type TextOptions = Parameters<PlaywrightPage["getByText"]>[1]

export interface Locator {
  readonly raw: PlaywrightLocator
  readonly locator: (selector: string) => Locator
  readonly getByRole: (role: Parameters<PlaywrightPage["getByRole"]>[0], options?: RoleOptions) => Locator
  readonly getByText: (text: string | RegExp, options?: TextOptions) => Locator
  readonly first: () => Locator
  readonly nth: (index: number) => Locator
  readonly all: Effect.Effect<ReadonlyArray<Locator>, BrowserError>
  readonly count: Effect.Effect<number, BrowserError>
  readonly click: Effect.Effect<void, BrowserError>
  readonly fill: (value: string) => Effect.Effect<void, BrowserError>
  readonly innerText: Effect.Effect<string, BrowserError>
  readonly allInnerTexts: Effect.Effect<ReadonlyArray<string>, BrowserError>
  readonly getAttribute: (name: string) => Effect.Effect<Option.Option<string>, BrowserError>
  readonly isVisible: Effect.Effect<boolean, BrowserError>
  readonly waitFor: Effect.Effect<void, BrowserError>
}

const makeLocator = (raw: PlaywrightLocator): Locator => ({
  raw,
  locator: (selector) => makeLocator(raw.locator(selector)),
  getByRole: (role, options) => makeLocator(raw.getByRole(role, options)),
  getByText: (text, options) => makeLocator(raw.getByText(text, options)),
  first: () => makeLocator(raw.first()),
  nth: (index) => makeLocator(raw.nth(index)),
  all: attempt(`list ${raw}`, () => raw.all()).pipe(Effect.map((locators) => locators.map(makeLocator))),
  count: attempt(`count ${raw}`, () => raw.count()),
  click: attempt(`click ${raw}`, () => raw.click()),
  fill: (value) => attempt(`fill ${raw}`, () => raw.fill(value)),
  innerText: attempt(`read text of ${raw}`, () => raw.innerText()),
  allInnerTexts: attempt(`read texts of ${raw}`, () => raw.allInnerTexts()),
  getAttribute: (name) =>
    attempt(`read ${name} of ${raw}`, () => raw.getAttribute(name)).pipe(Effect.map(Option.fromNullOr)),
  isVisible: attempt(`check visibility of ${raw}`, () => raw.isVisible()),
  waitFor: attempt(`wait for ${raw}`, () => raw.waitFor()),
})

export interface Page {
  readonly raw: PlaywrightPage
  readonly goto: (url: string) => Effect.Effect<void, BrowserError>
  readonly url: Effect.Effect<string>
  readonly title: Effect.Effect<string, BrowserError>
  readonly content: Effect.Effect<string, BrowserError>
  readonly locator: (selector: string) => Locator
  readonly getByRole: (role: Parameters<PlaywrightPage["getByRole"]>[0], options?: RoleOptions) => Locator
  readonly getByText: (text: string | RegExp, options?: TextOptions) => Locator
  readonly screenshot: (path: string) => Effect.Effect<void, BrowserError>
  readonly use: <A>(operation: string, f: (page: PlaywrightPage) => Promise<A>) => Effect.Effect<A, BrowserError>
}

const makePage = (raw: PlaywrightPage): Page => ({
  raw,
  goto: (url) => attempt(`load ${url}`, () => raw.goto(url)),
  url: Effect.sync(() => raw.url()),
  title: attempt("read title", () => raw.title()),
  content: attempt("read content", () => raw.content()),
  locator: (selector) => makeLocator(raw.locator(selector)),
  getByRole: (role, options) => makeLocator(raw.getByRole(role, options)),
  getByText: (text, options) => makeLocator(raw.getByText(text, options)),
  screenshot: (path) => attempt(`screenshot to ${path}`, () => raw.screenshot({ path })),
  use: (operation, f) => attempt(operation, () => f(raw)),
})

export class Browser extends Context.Service<
  Browser,
  {
    readonly newPage: Effect.Effect<Page, BrowserError, Scope.Scope>
  }
>()("Browser") {
  static readonly layer = (options?: LaunchOptions) =>
    Layer.effect(
      Browser,
      Effect.gen(function* () {
        const browser = yield* Effect.acquireRelease(
          attempt("launch", () =>
            // Playwright's own signal handlers kill the browser without interrupting the program, which
            // then runs on against a dead browser and exits 0; the Effect runtime owns signals instead.
            chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, ...options }),
          ),
          (browser) => attempt("close", () => browser.close()).pipe(Effect.ignore({ log: "Warn" })),
        )

        const newPage = Effect.acquireRelease(attempt("open page", () => browser.newContext()), (context) =>
          attempt("close page", () => context.close()).pipe(Effect.ignore({ log: "Warn" })),
        ).pipe(
          Effect.flatMap((context) => attempt("open page", () => context.newPage())),
          Effect.map(makePage),
        )

        return { newPage }
      }),
    )
}

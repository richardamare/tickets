import { Cause, Console, Context, Data, Effect, Layer, Option, type Scope } from "effect"
import { Flag, GlobalFlag } from "effect/unstable/cli"
import { browserName, makeBrowserProfiles, type BrowserKind, type BrowserSelection } from "./browser-config.ts"
import { launchBrowser } from "./browser-runtime.ts"
import { type Locator as PlaywrightLocator, type Page as PlaywrightPage } from "playwright"

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

export interface LocatorShape {
  readonly raw: PlaywrightLocator
  readonly locator: (selector: string) => LocatorShape
  readonly getByRole: (role: Parameters<PlaywrightPage["getByRole"]>[0], options?: RoleOptions) => LocatorShape
  readonly getByText: (text: string | RegExp, options?: TextOptions) => LocatorShape
  readonly first: () => LocatorShape
  readonly nth: (index: number) => LocatorShape
  readonly all: Effect.Effect<ReadonlyArray<LocatorShape>, BrowserError>
  readonly count: Effect.Effect<number, BrowserError>
  readonly mouseClick: Effect.Effect<void, BrowserError>
  readonly mouseDrag: (by: { readonly x: number; readonly y: number }) => Effect.Effect<void, BrowserError>
  readonly fill: (value: string) => Effect.Effect<void, BrowserError>
  readonly innerText: Effect.Effect<string, BrowserError>
  readonly allInnerTexts: Effect.Effect<ReadonlyArray<string>, BrowserError>
  readonly getAttribute: (name: string) => Effect.Effect<Option.Option<string>, BrowserError>
  readonly isVisible: Effect.Effect<boolean, BrowserError>
  readonly waitFor: Effect.Effect<void, BrowserError>
}

// Playwright does not expose where its cursor is, so each page's last position is kept here.
const cursors = new WeakMap<PlaywrightPage, { x: number; y: number }>()

const between = (min: number, max: number) => min + Math.random() * (max - min)

const moveMouse = (page: PlaywrightPage, to: { x: number; y: number }) => Effect.gen(function* () {
  const from = cursors.get(page) ?? { x: between(0, 50), y: between(0, 50) }
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  // A control point off the straight line bows the path the way a hand does.
  const bend = between(-0.3, 0.3) * distance
  const control = {
    x: (from.x + to.x) / 2 - ((to.y - from.y) / (distance || 1)) * bend,
    y: (from.y + to.y) / 2 + ((to.x - from.x) / (distance || 1)) * bend,
  }
  const steps = Math.max(10, Math.round(distance / 15))
  for (let step = 1; step <= steps; step++) {
    const linear = step / steps
    const t = linear < 0.5 ? 2 * linear ** 2 : 1 - (-2 * linear + 2) ** 2 / 2
    yield* attempt("move mouse", () => page.mouse.move(
      (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t ** 2 * to.x,
      (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t ** 2 * to.y,
    ))
    yield* Effect.sleep(between(5, 15))
  }
  cursors.set(page, to)
})

const mouseClick = (locator: PlaywrightLocator) => Effect.gen(function* () {
  yield* attempt("scroll to click target", () => locator.scrollIntoViewIfNeeded())
  const box = yield* attempt("locate click target", () => locator.boundingBox())
  if (!box) return yield* new BrowserError({ operation: "mouse click", cause: "the element has no box on screen" })
  const page = locator.page()
  const point = { x: box.x + box.width * between(0.3, 0.7), y: box.y + box.height * between(0.3, 0.7) }
  yield* moveMouse(page, point)
  yield* Effect.sleep(between(60, 180))
  // The cursor's path can open a hover menu or tooltip over the target, and a click there would hit that instead.
  const cover = yield* attempt("check click target", () => locator.evaluate((element, { x, y }) => {
    let hit = element.ownerDocument.elementFromPoint(x, y)
    // A shadow host reports itself as the hit; the element under the point sits inside its shadow root.
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y)
      if (inner === null || inner === hit) break
      hit = inner
    }
    if (hit === null || element === hit || element.contains(hit)) return undefined
    const classes = typeof hit.className === "string" ? hit.className.trim().split(/\s+/).slice(0, 3).join(".") : ""
    const text = (hit.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)
    return `<${hit.tagName.toLowerCase()}${classes ? `.${classes}` : ""}>${text ? ` "${text}"` : ""}`
  }, point))
  if (cover !== undefined) return yield* new BrowserError({ operation: "mouse click", cause: `not clicked: the element is covered by ${cover}` })
  yield* attempt("press mouse", () => page.mouse.down())
  yield* Effect.sleep(between(40, 110)).pipe(Effect.ensuring(attempt("release mouse", () => page.mouse.up()).pipe(Effect.ignore)))
})

const mouseDrag = (locator: PlaywrightLocator, by: { readonly x: number; readonly y: number }) => Effect.gen(function* () {
  // A drag that starts below the fold scrolls the page instead of moving the element, so centre it first.
  yield* attempt("scroll to drag target", () => locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" })))
  const box = yield* attempt("locate drag target", () => locator.boundingBox())
  if (!box) return yield* new BrowserError({ operation: "mouse drag", cause: "the element has no box on screen" })
  const page = locator.page()
  const from = { x: box.x + box.width * between(0.4, 0.6), y: box.y + box.height * between(0.4, 0.6) }
  yield* moveMouse(page, from)
  yield* attempt("press mouse", () => page.mouse.down())
  yield* moveMouse(page, { x: from.x + by.x, y: from.y + by.y }).pipe(
    Effect.andThen(Effect.sleep(between(40, 110))),
    Effect.ensuring(attempt("release mouse", () => page.mouse.up()).pipe(Effect.ignore)),
  )
})

const makeLocator = (raw: PlaywrightLocator): LocatorShape => ({
  raw,
  locator: (selector) => makeLocator(raw.locator(selector)),
  getByRole: (role, options) => makeLocator(raw.getByRole(role, options)),
  getByText: (text, options) => makeLocator(raw.getByText(text, options)),
  first: () => makeLocator(raw.first()),
  nth: (index) => makeLocator(raw.nth(index)),
  all: attempt(`list ${raw}`, () => raw.all()).pipe(Effect.map((locators) => locators.map(makeLocator))),
  count: attempt(`count ${raw}`, () => raw.count()),
  mouseClick: Effect.logDebug(`Mouse click on ${raw}`).pipe(Effect.andThen(mouseClick(raw))),
  mouseDrag: (by) =>
    Effect.logDebug(`Mouse drag on ${raw} by ${Math.round(by.x)},${Math.round(by.y)}`).pipe(
      Effect.andThen(mouseDrag(raw, by)),
    ),
  fill: (value) => attempt(`fill ${raw}`, () => raw.fill(value)),
  innerText: attempt(`read text of ${raw}`, () => raw.innerText()),
  allInnerTexts: attempt(`read texts of ${raw}`, () => raw.allInnerTexts()),
  getAttribute: (name) =>
    attempt(`read ${name} of ${raw}`, () => raw.getAttribute(name)).pipe(Effect.map(Option.fromNullOr)),
  isVisible: attempt(`check visibility of ${raw}`, () => raw.isVisible()),
  waitFor: attempt(`wait for ${raw}`, () => raw.waitFor()),
})

export interface PageShape {
  readonly raw: PlaywrightPage
  readonly goto: (url: string) => Effect.Effect<void, BrowserError>
  readonly url: Effect.Effect<string>
  readonly title: Effect.Effect<string, BrowserError>
  readonly content: Effect.Effect<string, BrowserError>
  readonly locator: (selector: string) => LocatorShape
  readonly getByRole: (role: Parameters<PlaywrightPage["getByRole"]>[0], options?: RoleOptions) => LocatorShape
  readonly getByText: (text: string | RegExp, options?: TextOptions) => LocatorShape
  readonly waitForLoad: Effect.Effect<void, BrowserError>
  readonly screenshot: (path: string) => Effect.Effect<void, BrowserError>
  readonly responseText: (matches: (url: string) => boolean) => Effect.Effect<string, BrowserError>
  readonly use: <A>(operation: string, f: (page: PlaywrightPage) => Promise<A>) => Effect.Effect<A, BrowserError>
}

const makePage = (raw: PlaywrightPage): PageShape => ({
  raw,
  goto: (url) =>
    Effect.logInfo(`Loading ${url}`).pipe(
      Effect.andThen(attempt(`load ${url}`, () => raw.goto(url))),
      Effect.andThen(Effect.logDebug(`Loaded ${raw.url()}`)),
      Effect.withLogSpan("load"),
    ),
  url: Effect.sync(() => raw.url()),
  title: attempt("read title", () => raw.title()),
  content: attempt("read content", () => raw.content()),
  locator: (selector) => makeLocator(raw.locator(selector)),
  getByRole: (role, options) => makeLocator(raw.getByRole(role, options)),
  getByText: (text, options) => makeLocator(raw.getByText(text, options)),
  waitForLoad: attempt("wait for page load", () => raw.waitForLoadState("domcontentloaded")),
  screenshot: (path) => attempt(`screenshot to ${path}`, () => raw.screenshot({ path })),
  responseText: (matches) =>
    attempt("wait for a response", () =>
      raw.waitForResponse((response) => response.ok() && matches(response.url())).then((response) => response.text()),
    ),
  use: (operation, f) => attempt(operation, () => f(raw)),
})

export const BrowserFlag = GlobalFlag.Setting("browser")({
  flag: Flag.Literals("browser", ["chrome", "edge"]).pipe(Flag.withDescription("Choose Chrome or Edge"), Flag.optional),
})

export const ProfileFlag = GlobalFlag.Setting("profile")({
  flag: Flag.String("profile").pipe(Flag.withDescription("Choose the reusable account configured with profile <name>"), Flag.optional),
})

export const setupProfile = (name: string, browser?: BrowserKind) => Effect.scoped(Effect.gen(function* () {
  const profiles = yield* makeBrowserProfiles()
  const selection = yield* profiles.resolveSelection(browser, name)
  const source = yield* profiles.prepareSetup(selection)
  yield* Effect.gen(function* () {
    yield* Effect.scoped(Effect.gen(function* () {
      const running = yield* launchBrowser(selection.browser, source, true)
      yield* profiles.markSetupOpened(selection)
      yield* Console.log(`Sign in to every site the "${name}" account needs in ${browserName(selection.browser)}, then close all its setup windows.`)
      yield* running.untilClosed
    }))
    yield* profiles.assertClosed(source)
    yield* profiles.markReady(selection)
    yield* profiles.saveSettings(selection)
    yield* Console.log(`Saved ${browserName(selection.browser)} account "${name}". Every listener uses its own copy.`)
  }).pipe(Effect.onError((cause) => profiles.markSetupFailed(selection, Cause.pretty(cause)).pipe(Effect.ignore({ log: "Warn" }))))
}))

export interface BrowserShape {
  readonly newPage: Effect.Effect<PageShape, BrowserError, Scope.Scope>
  readonly pid: number
  readonly untilClosed: Effect.Effect<void, BrowserError>
  readonly name: string
  readonly selection: BrowserSelection
  readonly clearCookies: (domain: RegExp) => Effect.Effect<void, BrowserError>
}

// Each browser runs on its own copy of the source profile, so several can run side by side.
const openBrowser = (selection: BrowserSelection) => Effect.gen(function* () {
  const profiles = yield* makeBrowserProfiles()
  const profile = yield* profiles.clone(selection)
  const running = yield* launchBrowser(selection.browser, profile, false)
  const name = browserName(selection.browser)
  const context = running.raw.contexts()[0]
  if (!context) return yield* new BrowserError({ operation: `attach to ${name}`, cause: "The browser exposed no default context" })
  const cdp = yield* attempt(`attach to ${name}`, () => running.raw.newBrowserCDPSession())
  const openInBackground = () => Promise.all([
    context.waitForEvent("page"),
    cdp.send("Target.createTarget", { url: "about:blank", background: true }),
  ]).then(([page]) => page)
  const newPage = Effect.acquireRelease(
    attempt("open page", openInBackground),
    (page) => attempt("close page", () => page.close()).pipe(Effect.ignore({ log: "Warn" })),
  ).pipe(Effect.map(makePage))
  return {
    newPage, pid: running.pid, name, selection,
    untilClosed: running.untilClosed.pipe(Effect.mapError((cause) => new BrowserError({ operation: "wait for browser windows to close", cause }))),
    clearCookies: (domain: RegExp) => attempt(`clear cookies for ${domain}`, () => context.clearCookies({ domain })),
  } satisfies BrowserShape
})

export class Browser extends Context.Service<
  Browser,
  BrowserShape & {
    // Another browser on a fresh copy of the same source, closed with the scope it opens in.
    readonly openAnother: Effect.Effect<BrowserShape, Effect.Error<ReturnType<typeof openBrowser>>, Scope.Scope>
  }
>()("Browser") {
  static readonly layerFor = (selection: BrowserSelection) => Layer.effect(Browser, Effect.gen(function* () {
    const first = yield* openBrowser(selection)
    const services = yield* Effect.context<Exclude<Effect.Services<ReturnType<typeof openBrowser>>, Scope.Scope>>()
    return { ...first, openAnother: openBrowser(selection).pipe(Effect.provideContext(services)) }
  }))

  static readonly layer = Layer.unwrap(Effect.gen(function* () {
    const profiles = yield* makeBrowserProfiles()
    const selection = yield* profiles.resolveSelection(Option.getOrUndefined(yield* BrowserFlag), Option.getOrUndefined(yield* ProfileFlag))
    return Browser.layerFor(selection)
  }))
}

export class Page extends Context.Service<Page, PageShape>()("Page") {
  static readonly layer = Layer.effect(Page, Browser.use((browser) => browser.newPage))
}

export class Locator extends Context.Service<Locator, LocatorShape>()("Locator") {
  static readonly at =
    (selector: string) =>
    <A, E, R>(self: Effect.Effect<A, E, R>) =>
      Effect.provideServiceEffect(self, Locator, Page.useSync((page) => page.locator(selector)))
}

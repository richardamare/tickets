import { chmod, lstat, mkdir, readlink, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Config, Console, Context, Data, Effect, Layer, Option, Schema, type Scope } from "effect"
import { Flag, GlobalFlag } from "effect/unstable/cli"
import { chromium, type Locator as PlaywrightLocator, type Page as PlaywrightPage } from "playwright"

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

const moveMouse = async (page: PlaywrightPage, to: { x: number; y: number }) => {
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
    await page.mouse.move(
      (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t ** 2 * to.x,
      (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t ** 2 * to.y,
    )
    await Bun.sleep(between(5, 15))
  }
  cursors.set(page, to)
}

const mouseClick = async (locator: PlaywrightLocator) => {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error("the element has no box on screen")
  const page = locator.page()
  const point = { x: box.x + box.width * between(0.3, 0.7), y: box.y + box.height * between(0.3, 0.7) }
  await moveMouse(page, point)
  await Bun.sleep(between(60, 180))
  // The cursor's path can open a hover menu or tooltip over the target, and a click there would hit that instead.
  const cover = await locator.evaluate((element, { x, y }) => {
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
  }, point)
  if (cover !== undefined) throw new Error(`not clicked: the element is covered by ${cover}`)
  await page.mouse.down()
  await Bun.sleep(between(40, 110))
  await page.mouse.up()
}

const mouseDrag = async (locator: PlaywrightLocator, by: { readonly x: number; readonly y: number }) => {
  // A drag that starts below the fold scrolls the page instead of moving the element, so centre it first.
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }))
  const box = await locator.boundingBox()
  if (!box) throw new Error("the element has no box on screen")
  const page = locator.page()
  const from = { x: box.x + box.width * between(0.4, 0.6), y: box.y + box.height * between(0.4, 0.6) }
  await moveMouse(page, from)
  await page.mouse.down()
  await moveMouse(page, { x: from.x + by.x, y: from.y + by.y })
  await Bun.sleep(between(40, 110))
  await page.mouse.up()
}

const makeLocator = (raw: PlaywrightLocator): LocatorShape => ({
  raw,
  locator: (selector) => makeLocator(raw.locator(selector)),
  getByRole: (role, options) => makeLocator(raw.getByRole(role, options)),
  getByText: (text, options) => makeLocator(raw.getByText(text, options)),
  first: () => makeLocator(raw.first()),
  nth: (index) => makeLocator(raw.nth(index)),
  all: attempt(`list ${raw}`, () => raw.all()).pipe(Effect.map((locators) => locators.map(makeLocator))),
  count: attempt(`count ${raw}`, () => raw.count()),
  mouseClick: Effect.logDebug(`Mouse click on ${raw}`).pipe(Effect.andThen(attempt(`mouse-click ${raw}`, () => mouseClick(raw)))),
  mouseDrag: (by) =>
    Effect.logDebug(`Mouse drag on ${raw} by ${Math.round(by.x)},${Math.round(by.y)}`).pipe(
      Effect.andThen(attempt(`mouse-drag ${raw}`, () => mouseDrag(raw, by))),
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

export const ProfileFlag = GlobalFlag.Setting("profile")({
  flag: Flag.String("profile").pipe(
    Flag.withDescription("Run as the Edge profile saved with `profile <name>` instead of the devbox base profile copy"),
    Flag.optional,
  ),
})

const profilesDir = join(homedir(), ".ticket-scraper", "profiles")

const namedProfile = (name: string) =>
  /^[\w.-]+$/.test(name) && name !== "." && name !== ".."
    ? Effect.succeed(join(profilesDir, name))
    : Effect.fail(new BrowserError({ operation: "choose the Edge profile", cause: `"${name}" is not a valid name; use letters, digits, ".", "_" or "-"` }))

const closeOnRelease = (launch: Effect.Effect<{ pid: number; cdpUrl: string }, BrowserError>) =>
  Effect.acquireRelease(
    launch.pipe(Effect.withLogSpan("launch")),
    ({ pid, cdpUrl }) =>
      Effect.logInfo(`Closing Edge (pid ${pid})`).pipe(
        Effect.andThen(Effect.promise(() => closeEdge(pid, cdpUrl))),
        Effect.andThen(Effect.logDebug("Edge closed")),
      ),
  )

export const setupProfile = (name: string) =>
  Effect.gen(function* () {
    const profile = yield* namedProfile(name)
    const created = yield* attempt("prepare the Edge profile", async () => {
      const created = !(await exists(profile))
      await mkdir(profile, { recursive: true })
      await unlockProfile(profile)
      return created
    })
    yield* Effect.logInfo(created ? `Created the empty Edge profile ${profile}` : `Reopening the Edge profile ${profile}`)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { pid, cdpUrl } = yield* closeOnRelease(launchEdge(profile, { visible: true }))
        yield* Console.log(`Sign in to every site the "${name}" account needs in the Edge window, then close the window.`)
        yield* attempt("wait for the Edge window to close", () => waitForWindowsClosed(pid, cdpUrl))
      }),
    )
    yield* Console.log(`Saved the "${name}" profile in ${profile}; run the other commands with --profile ${name} to use it.`)
  })

const savedProfile = (name: string) =>
  Effect.gen(function* () {
    const profile = yield* namedProfile(name)
    yield* attempt("prepare the Edge profile", async () => {
      if (!(await exists(join(profile, "Default", "Preferences")))) {
        throw new Error(`there is no saved profile "${name}"; create it with \`profile ${name}\` first`)
      }
      await unlockProfile(profile)
    })
    yield* Effect.logInfo(`Using the Edge profile ${profile}`)
    return profile
  })

const baseProfileCopy = Effect.gen(function* () {
  const base = yield* Config.String("EDGE_BASE_PROFILE").pipe(
    Config.withDefault(join(homedir(), ".devbox", "browser", "edge-base")),
  )
  const profile = yield* Config.String("EDGE_PROFILE").pipe(
    Config.withDefault(join(homedir(), ".ticket-scraper", "edge-profile")),
  )
  const cloned = yield* attempt("prepare the Edge profile", () => prepareProfile(base, profile))
  yield* Effect.logInfo(cloned ? `Cloned the Edge base profile ${base} into ${profile}` : `Using the Edge profile ${profile}`)
  return profile
})

export class Browser extends Context.Service<
  Browser,
  {
    readonly newPage: Effect.Effect<PageShape, BrowserError, Scope.Scope>
    readonly pid: number
    readonly untilClosed: Effect.Effect<void, BrowserError>
  }
>()("Browser") {
  static readonly layer = Layer.effect(
    Browser,
    Effect.gen(function* () {
      const profile = yield* Option.match(yield* ProfileFlag, { onSome: savedProfile, onNone: () => baseProfileCopy })
      const { pid, cdpUrl } = yield* closeOnRelease(launchEdge(profile, { visible: false }))
      const browser = yield* Effect.acquireRelease(
        attempt("attach to Edge", () => chromium.connectOverCDP(cdpUrl)).pipe(Effect.tap(Effect.logDebug("Playwright attached over CDP"))),
        (browser) => attempt("detach from Edge", () => browser.close()).pipe(Effect.ignore({ log: "Warn" })),
      )
      // Only the default context carries the profile's cookies; newContext() over CDP starts signed out.
      const context = browser.contexts()[0]
      if (!context) return yield* new BrowserError({ operation: "attach to Edge", cause: "Edge exposed no browser context" })

      const cdp = yield* attempt("attach to Edge", () => browser.newBrowserCDPSession())
      // context.newPage() brings Edge to the front; a background target leaves focus with the app in use.
      const openInBackground = () =>
        Promise.all([
          context.waitForEvent("page"),
          cdp.send("Target.createTarget", { url: "about:blank", background: true }),
        ]).then(([page]) => page)

      const newPage = Effect.acquireRelease(
        attempt("open page", openInBackground).pipe(Effect.tap(Effect.logDebug("Opened a background tab"))),
        (page) =>
          attempt("close page", () => page.close()).pipe(Effect.ignore({ log: "Warn" }), Effect.andThen(Effect.logDebug("Closed the tab"))),
      ).pipe(Effect.map(makePage))

      const untilClosed = attempt("wait for the Edge window to close", () => waitForWindowsClosed(pid, cdpUrl))

      return { newPage, pid, untilClosed }
    }),
  )
}

const edgeApp = "/Applications/Microsoft Edge.app"

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  )

// Chromium's SingletonLock is a symlink to "<host>-<pid>" of the Edge that holds the profile.
const lockHolder = async (profile: string) => {
  const target = await readlink(join(profile, "SingletonLock")).catch(() => undefined)
  const pid = Number(target?.slice(target.lastIndexOf("-") + 1))
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const prepareProfile = async (base: string, profile: string) => {
  const cloned = !(await exists(profile))
  if (cloned) {
    if (!(await exists(join(base, "Default", "Preferences"))) || (await lockHolder(base)) !== undefined) {
      throw new Error(
        `the base profile ${base} is not ready; sign in with \`devbox browser profile open\`, close that Edge window, then retry`,
      )
    }
    await mkdir(dirname(profile), { recursive: true })
    await Bun.$`cp -cR ${base} ${profile}`.quiet()
  }
  await unlockProfile(profile)
  return cloned
}

const unlockProfile = async (profile: string) => {
  await chmod(profile, 0o700)
  const holder = await lockHolder(profile)
  if (holder !== undefined) throw new Error(`Edge (pid ${holder}) is already running on ${profile}`)
  // A copied or crashed profile keeps these, and Edge would otherwise hand off to an instance that no longer exists.
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) {
    await rm(join(profile, name), { force: true })
  }
}

const launchEdge = (profile: string, { visible }: { readonly visible: boolean }) =>
  attempt("launch Edge", async () => {
    // open -g starts Edge without activating it; -n makes it a separate instance even
    // while an everyday Edge runs. launchd owns the process, so Ctrl+C here does not kill it mid-write.
    await Bun.$`open ${visible ? [] : ["-g"]} -n -a ${edgeApp} --args ${[
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      // No window until a page is opened, since the first window would otherwise take focus.
      ...(visible ? [] : ["--no-startup-window"]),
      // Pages stay in background tabs, which Edge would otherwise throttle or stop rendering.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ]}`.quiet()
    try {
      // A sign-in page is expected in a visible window, since signing in is what it is for.
      const cdpUrl = await waitForCdp(profile, { signInAllowed: visible })
      const pid = await lockHolder(profile)
      if (pid === undefined) throw new Error(`Edge exposed CDP at ${cdpUrl} but holds no lock on ${profile}`)
      return { pid, cdpUrl }
    } catch (error) {
      const pid = await lockHolder(profile)
      if (pid !== undefined) process.kill(pid, "SIGTERM")
      throw error
    }
  })

const CdpTargets = Schema.fromJsonString(Schema.Array(Schema.Struct({ type: Schema.String, url: Schema.String })))
const CdpVersion = Schema.fromJsonString(Schema.Struct({ webSocketDebuggerUrl: Schema.String }))
const CdpCommand = Schema.fromJsonString(Schema.Struct({ id: Schema.Number, method: Schema.String }))

const listTargets = (cdpUrl: string) =>
  fetch(`${cdpUrl}/json/list`).then(
    async (response) => (response.ok ? Schema.decodeUnknownPromise(CdpTargets)(await response.text()) : undefined),
    () => undefined,
  )

const waitForCdp = async (profile: string, { signInAllowed }: { readonly signInAllowed: boolean }) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    // With port 0, Edge picks a free port and writes it on the first line of DevToolsActivePort.
    const port = Number((await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => "")).split("\n")[0])
    if (port > 0) {
      const cdpUrl = `http://127.0.0.1:${port}`
      const targets = await listTargets(cdpUrl)
      if (targets) {
        if (!signInAllowed && targets.some((target) => target.url.startsWith("edge://force-signin"))) {
          throw new Error(
            `Edge asks for an interactive sign-in, so the base profile's sign-in did not carry over; sign in to the base profile, close it, delete ${profile} and retry`,
          )
        }
        return cdpUrl
      }
    }
    await Bun.sleep(250)
  }
  throw new Error("Edge did not expose its CDP endpoint within 10 seconds")
}

// On macOS Edge keeps running after its last window closes, so that is detected as no page targets left.
const waitForWindowsClosed = async (pid: number, cdpUrl: string) => {
  let opened = false
  while (isAlive(pid)) {
    const targets = await listTargets(cdpUrl)
    if (targets) {
      const open = targets.some((target) => target.type === "page")
      if (open) opened = true
      else if (opened) return
    }
    await Bun.sleep(500)
  }
}

// Browser.close lets Edge flush the profile to disk; SIGTERM is the fallback when it does not exit in time.
const closeEdge = async (pid: number, cdpUrl: string) => {
  const version = await fetch(`${cdpUrl}/json/version`)
    .then(async (response) => Schema.decodeUnknownPromise(CdpVersion)(await response.text()))
    .catch(() => undefined)
  if (version) {
    const command = await Schema.encodePromise(CdpCommand)({ id: 1, method: "Browser.close" })
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    socket.addEventListener("open", () => socket.send(command))
    socket.addEventListener("error", () => socket.close())
  }
  for (let attempt = 0; attempt < 100 && isAlive(pid); attempt++) await Bun.sleep(100)
  if (isAlive(pid)) process.kill(pid, "SIGTERM")
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

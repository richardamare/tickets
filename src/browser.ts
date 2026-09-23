import { chmod, lstat, mkdir, readFile, readlink, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Config, Context, Data, Effect, Layer, Option, type Scope } from "effect"
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
  readonly click: Effect.Effect<void, BrowserError>
  readonly fill: (value: string) => Effect.Effect<void, BrowserError>
  readonly innerText: Effect.Effect<string, BrowserError>
  readonly allInnerTexts: Effect.Effect<ReadonlyArray<string>, BrowserError>
  readonly getAttribute: (name: string) => Effect.Effect<Option.Option<string>, BrowserError>
  readonly isVisible: Effect.Effect<boolean, BrowserError>
  readonly waitFor: Effect.Effect<void, BrowserError>
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
  click: attempt(`click ${raw}`, () => raw.click()),
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
  readonly use: <A>(operation: string, f: (page: PlaywrightPage) => Promise<A>) => Effect.Effect<A, BrowserError>
}

const makePage = (raw: PlaywrightPage): PageShape => ({
  raw,
  goto: (url) => attempt(`load ${url}`, () => raw.goto(url)),
  url: Effect.sync(() => raw.url()),
  title: attempt("read title", () => raw.title()),
  content: attempt("read content", () => raw.content()),
  locator: (selector) => makeLocator(raw.locator(selector)),
  getByRole: (role, options) => makeLocator(raw.getByRole(role, options)),
  getByText: (text, options) => makeLocator(raw.getByText(text, options)),
  waitForLoad: attempt("wait for page load", () => raw.waitForLoadState("domcontentloaded")),
  screenshot: (path) => attempt(`screenshot to ${path}`, () => raw.screenshot({ path })),
  use: (operation, f) => attempt(operation, () => f(raw)),
})

export class Browser extends Context.Service<
  Browser,
  {
    readonly newPage: Effect.Effect<PageShape, BrowserError, Scope.Scope>
  }
>()("Browser") {
  static readonly layer = Layer.effect(
    Browser,
    Effect.gen(function* () {
      const base = yield* Config.String("EDGE_BASE_PROFILE").pipe(
        Config.withDefault(join(homedir(), ".devbox", "browser", "edge-base")),
      )
      const profile = yield* Config.String("EDGE_PROFILE").pipe(
        Config.withDefault(join(homedir(), ".ticket-scraper", "edge-profile")),
      )
      yield* attempt("prepare the Edge profile", () => prepareProfile(base, profile))
      const { cdpUrl } = yield* Effect.acquireRelease(launchEdge(profile), ({ edge, cdpUrl }) =>
        Effect.promise(() => closeEdge(edge, cdpUrl)),
      )
      const browser = yield* Effect.acquireRelease(
        attempt("attach to Edge", () => chromium.connectOverCDP(cdpUrl)),
        (browser) => attempt("detach from Edge", () => browser.close()).pipe(Effect.ignore({ log: "Warn" })),
      )
      // Only the default context carries the profile's cookies; newContext() over CDP starts signed out.
      const context = browser.contexts()[0]
      if (!context) return yield* new BrowserError({ operation: "attach to Edge", cause: "Edge exposed no browser context" })

      const newPage = Effect.acquireRelease(attempt("open page", () => context.newPage()), (page) =>
        attempt("close page", () => page.close()).pipe(Effect.ignore({ log: "Warn" })),
      ).pipe(Effect.map(makePage))

      return { newPage }
    }),
  )
}

const edgeExecutable = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  )

// Chromium's SingletonLock is a symlink to "<host>-<pid>" of the Edge that holds the profile.
const lockHolder = async (profile: string) => {
  const target = await readlink(join(profile, "SingletonLock")).catch(() => undefined)
  const pid = Number(target?.slice(target.lastIndexOf("-") + 1))
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined
  }
}

const prepareProfile = async (base: string, profile: string) => {
  if (!(await exists(profile))) {
    if (!(await exists(join(base, "Default", "Preferences"))) || (await lockHolder(base)) !== undefined) {
      throw new Error(
        `the base profile ${base} is not ready; sign in with \`devbox browser profile open\`, close that Edge window, then retry`,
      )
    }
    await mkdir(dirname(profile), { recursive: true })
    await Bun.$`cp -cR ${base} ${profile}`.quiet()
  }
  await chmod(profile, 0o700)
  const holder = await lockHolder(profile)
  if (holder !== undefined) throw new Error(`Edge (pid ${holder}) is already running on ${profile}`)
  // A copied or crashed profile keeps these, and Edge would otherwise hand off to an instance that no longer exists.
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) {
    await rm(join(profile, name), { force: true })
  }
}

const launchEdge = (profile: string) =>
  attempt("launch Edge", async () => {
    const edge = Bun.spawn(
      [
        edgeExecutable,
        `--user-data-dir=${profile}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      // Its own process group, so Ctrl+C reaches only this program and Edge is closed through CDP, saving the profile.
      { stdio: ["ignore", "ignore", "ignore"], detached: true },
    )
    try {
      return { edge, cdpUrl: await waitForCdp(edge, profile) }
    } catch (error) {
      edge.kill("SIGTERM")
      throw error
    }
  })

const waitForCdp = async (edge: Bun.Subprocess, profile: string) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (edge.exitCode !== null) throw new Error(`Edge exited with code ${edge.exitCode} before exposing CDP`)
    // With port 0, Edge picks a free port and writes it on the first line of DevToolsActivePort.
    const port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0])
    if (port > 0) {
      const cdpUrl = `http://127.0.0.1:${port}`
      const targets = await fetch(`${cdpUrl}/json/list`).then(
        (response) => (response.ok ? (response.json() as Promise<ReadonlyArray<{ url: string }>>) : undefined),
        () => undefined,
      )
      if (targets) {
        if (targets.some((target) => target.url.startsWith("edge://force-signin"))) {
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

// Browser.close lets Edge flush the profile to disk; SIGTERM is the fallback when it does not exit in time.
const closeEdge = async (edge: Bun.Subprocess, cdpUrl: string) => {
  const version = await fetch(`${cdpUrl}/json/version`)
    .then((response) => response.json() as Promise<{ webSocketDebuggerUrl: string }>)
    .catch(() => undefined)
  if (version) {
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })))
    socket.addEventListener("error", () => socket.close())
  }
  const exited = await Promise.race([edge.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!exited) edge.kill("SIGTERM")
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

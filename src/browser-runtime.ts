import { Effect, FileSystem, Path } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { chromium } from "playwright"
import { browserName, ensureBrowserInstalled, ProfileError, type BrowserKind } from "./browser-config.ts"

export const launchBrowser = (kind: BrowserKind, profile: string, visible: boolean) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const executable = yield* ensureBrowserInstalled(kind)
  const child = yield* ChildProcess.make(executable, [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    ...(visible ? ["about:blank"] : ["--no-startup-window"]),
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ], { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "5 seconds" })
  const connect = Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(yield* child.isRunning)) return yield* new ProfileError({ message: `${browserName(kind)} exited before opening its automation endpoint. Reopen the account with /setup.` })
      const file = path.join(profile, "DevToolsActivePort")
      const contents = yield* fs.readFileString(file).pipe(Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error)))
      const port = Number(contents.split("\n")[0])
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        const connected = yield* Effect.tryPromise(() => chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 })).pipe(Effect.option)
        if (connected._tag === "Some") return connected.value
      }
      yield* Effect.sleep("250 millis")
    }
    return yield* new ProfileError({ message: `${browserName(kind)} did not open its automation endpoint. Close the setup browser and retry /setup.` })
  })
  const raw = yield* Effect.acquireRelease(connect, (browser) => Effect.gen(function* () {
    if (yield* child.isRunning) {
      yield* Effect.tryPromise(async () => {
        const session = await browser.newBrowserCDPSession()
        await session.send("Browser.close")
      }).pipe(Effect.timeoutOption("2 seconds"), Effect.ignore)
      const exited = yield* child.exitCode.pipe(Effect.timeoutOption("5 seconds"))
      if (exited._tag === "None") yield* child.kill({ forceKillAfter: "5 seconds" })
    }
    yield* Effect.tryPromise(() => browser.close()).pipe(Effect.ignore)
  }).pipe(Effect.ignore({ log: "Warn" })))
  const untilClosed = Effect.gen(function* () {
    let opened = false
    while (yield* child.isRunning) {
      if (!raw.isConnected()) return
      const pages = raw.contexts().flatMap((context) => context.pages())
      if (pages.length > 0) opened = true
      else if (opened) return
      yield* Effect.sleep("250 millis")
    }
  })
  if (!visible && raw.contexts().flatMap((context) => context.pages()).some((page) => page.url().startsWith("edge://force-signin"))) {
    return yield* new ProfileError({ message: "Edge requires interactive sign-in. Open /setup, complete sign-in and close the setup window before retrying." })
  }
  return { pid: Number(child.pid), raw, untilClosed }
})

import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { Browser } from "./browser.ts"
import { makeBrowserProfiles } from "./browser-config.ts"
import { makeListenerRegistry } from "./listeners.ts"
import { ListenerRequest } from "./listener-request.ts"

for (const [kind, url, flag, value, message] of [
  ["watch", "https://www.fnacspectacles.com/event/event-106/", "--every", "1000001", "number from 0.5 to 1000000 seconds"],
  ["restock", "https://fnacspectacles.com/event/show-123/", "--every", "1000001", "number from 0.5 to 1000000 seconds"],
  ["watch", "https://www.fnacspectacles.com/event/event-106/", "--every", "0.49", "number from 0.5 to 1000000 seconds"],
  ["restock", "https://fnacspectacles.com/event/show-123/", "--every", "0.49", "number from 0.5 to 1000000 seconds"],
  ["restock", "https://fnacspectacles.com/event/show-123/", "--quantity", "101", "whole number from 1 to 100"],
] as const) {
  test(`CLI and request schema reject ${kind} ${flag} ${value} before opening a browser`, async () => {
    expect(Schema.is(ListenerRequest)({ kind, url, profile: "default", browser: "chrome", every: flag === "--every" ? Number(value) : 10, ...(kind === "watch" ? { until: "" } : { quantity: flag === "--quantity" ? Number(value) : 1 }) })).toBe(false)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const path = yield* Path.Path
      const main = yield* path.fromFileUrl(new URL("./main.ts", import.meta.url))
      const child = yield* ChildProcess.make(process.execPath, [main, kind, url, flag, value], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = yield* Effect.all([child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.stderr.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], { concurrency: 3 })
      expect(Number(code)).not.toBe(0)
      expect(stdout + stderr).toContain(message)
    })).pipe(Effect.provide(BunServices.layer)))
  })
}

for (const kind of ["watch", "restock"] as const) {
  for (const explicit of [false, true]) {
    test(`${kind} CLI records a half-second interval with ${explicit ? "--every 0.5" : "defaults"}`, async () => {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "listener-interval-" })
        const main = yield* path.fromFileUrl(new URL("./main.ts", import.meta.url))
        const directory = path.join(root, "listeners")
        // Watch opens no browser, so it runs one check through a proxy that refuses it instead of reaching Eventim.
        const once = kind === "watch" ? ["--once"] : []
        const child = yield* ChildProcess.make(process.execPath, [main, kind, "https://fnacspectacles.com/event/show-123/", ...once, ...(explicit ? ["--every", "0.5"] : []), "--browser", "chrome"], {
          stdin: "ignore", stdout: "pipe", stderr: "pipe", extendEnv: true,
          env: { TICKET_LISTENERS_DIR: directory, TICKET_BROWSER_HOME: path.join(root, "browsers"), HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" },
        })
        const [stdout, stderr, code] = yield* Effect.all([child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.stderr.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], { concurrency: 3 })
        expect(Number(code)).not.toBe(0)
        expect(stdout + stderr).toContain(kind === "watch" ? "1 of 1 checks failed" : "not set up")
        const registry = yield* makeListenerRegistry(directory)
        const rows = yield* registry.read
        expect(rows).toHaveLength(1)
        expect(rows[0]!.everySeconds).toBe(0.5)
      })).pipe(Effect.provide(BunServices.layer)))
    })
  }
}

test("captured browser selection matches the listener record after saved defaults change", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "listener-selection-" })
    const profiles = yield* makeBrowserProfiles(path.join(root, "browsers"))
    yield* profiles.saveSettings({ browser: "chrome", profile: "alice" })
    const selection = yield* profiles.resolveSelection()
    const registry = yield* makeListenerRegistry(path.join(root, "listeners"))
    yield* registry.start({ kind: "watch", url: "https://www.fnacspectacles.com/event/event-106/", ...selection, profileKey: `named:${selection.profile}`, everySeconds: 900 })
    yield* profiles.saveSettings({ browser: "edge", profile: "bob" })
    const result = yield* Browser.use((browser) => Effect.succeed(browser.selection)).pipe(
      Effect.provide(Browser.layerFor(selection)),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ ...process.env, TICKET_BROWSER_HOME: profiles.root })),
      Effect.result,
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("Chrome account 'alice' is not set up")
      expect(result.failure.message).not.toContain("bob")
    }
    const record = (yield* registry.read)[0]!
    expect({ browser: record.browser, profile: record.profile }).toEqual(selection)
  })).pipe(Effect.provide(BunServices.layer)))
})

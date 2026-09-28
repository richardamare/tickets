import { mock } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Config, ConfigProvider, Effect, FileSystem, Path, PlatformError } from "effect"

mock.module("../browser-runtime.ts", () => ({ launchBrowser: () => Effect.succeed({ pid: process.pid, untilClosed: Effect.void }) }))
const { setupProfile } = await import("../browser.ts")
const { makeBrowserProfiles } = await import("../browser-config.ts")

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const mode = yield* Config.String("TICKET_TEST_SETUP_FAILURE")
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ticket-setup-failure-" })
  const selection = { browser: "chrome", profile: "failed" } as const
  const previous = { browser: "chrome", profile: "previous" } as const
  const profiles = yield* makeBrowserProfiles(root)
  yield* profiles.saveSettings(previous)
  const failure = (method: string) => Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method, description: `Controlled ${mode} failure` }))
  const blocked: FileSystem.FileSystem = {
    ...fs,
    writeFileString: (file, text, options) => mode === "ready" && file === path.join(root, "chrome", "failed", "ready") ? failure("writeFileString") : fs.writeFileString(file, text, options),
    rename: (from, to) => mode === "settings" && to === path.join(root, "settings.json") ? failure("rename") : fs.rename(from, to),
  }
  const result = yield* setupProfile(selection.profile, selection.browser).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ HOME: root, TICKET_BROWSER_HOME: root })),
    Effect.provideService(FileSystem.FileSystem, blocked),
    Effect.result,
  )
  if (result._tag !== "Failure") throw new Error("Setup unexpectedly succeeded")
  const status = yield* profiles.status(selection)
  if (status.ready || status.settingUp || !status.setupError?.includes(`Controlled ${mode} failure`)) throw new Error(`Failed setup is not actionable: ${JSON.stringify(status)}`)
  if (yield* fs.exists(path.join(root, "chrome", "failed", "ready"))) throw new Error("Failed setup retained its success marker")
  if ((yield* profiles.readSettings).profile !== previous.profile) throw new Error("Failed setup replaced the previous defaults")
  const clone = yield* profiles.clone(selection).pipe(Effect.result)
  if (clone._tag !== "Failure") throw new Error("Failed source could be cloned")
})).pipe(Effect.provide(BunServices.layer)))

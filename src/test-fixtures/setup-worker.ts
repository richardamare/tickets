import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path } from "effect"
import { makeBrowserProfiles } from "../browser-config.ts"

Effect.scoped(Effect.gen(function* () {
  const profiles = yield* makeBrowserProfiles()
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const selection = { browser: "chrome", profile: "fixture" } as const
  yield* profiles.prepareSetup(selection)
  if (yield* Config.Boolean("TICKET_TEST_SETUP_FAIL").pipe(Config.withDefault(false))) {
    yield* profiles.markSetupFailed(selection, "Controlled failure before browser opens")
    return yield* Effect.fail(new Error("Controlled failure before browser opens"))
  }
  yield* profiles.markSetupOpened(selection)
  while (!(yield* fs.exists(path.join(profiles.root, "close-setup")))) {
    yield* fs.writeFileString(path.join(profiles.root, "setup-tick"), String(Date.now()))
    yield* Effect.sleep("100 millis")
  }
  yield* profiles.markReady(selection)
  yield* profiles.saveSettings(selection)
})).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)

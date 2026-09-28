import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { makeListenerLauncher } from "../listener-launcher.ts"
import { makeBrowserProfiles } from "../browser-config.ts"
import { dashboard } from "../tui.ts"

Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const path = yield* Path.Path
  const isSetup = yield* Config.Boolean("TICKET_TEST_SETUP").pipe(Config.withDefault(false))
  const worker = yield* path.fromFileUrl(new URL(isSetup ? "./setup-worker.ts" : "./listener-worker.ts", import.meta.url))
  const replacement = ChildProcessSpawner.make((command) => spawner.spawn(command._tag === "StandardCommand" && command.command === process.execPath
    ? ChildProcess.make(command.command, [worker, ...command.args.slice(1)], command.options)
    : command))
  const fs = yield* FileSystem.FileSystem
  const profiles = yield* makeBrowserProfiles()
  yield* fs.makeDirectory(path.join(profiles.root, "chrome", "default"), { recursive: true })
  yield* profiles.markReady({ browser: "chrome", profile: "default" })
  const interactive = yield* Config.Boolean("TICKET_TEST_INTERACTIVE").pipe(Config.withDefault(false))
  const wait = yield* Config.Boolean("TICKET_TEST_PARENT_WAIT").pipe(Config.withDefault(false))
  if (interactive) yield* dashboard.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, replacement))
  else yield* Effect.gen(function* () {
    const launcher = yield* makeListenerLauncher
    if (isSetup) {
      yield* launcher.setup({ browser: "chrome", profile: "fixture" })
      if (wait) yield* Effect.never
      return
    }
    const count = yield* Config.Number("TICKET_TEST_COUNT").pipe(Config.withDefault(1))
    for (let i = 0; i < count; i++) yield* launcher.launch({ kind: "watch", url: "https://www.fnacspectacles.com/event/background-test-104/", every: 5, until: "", profile: "" })
    if (wait) yield* Effect.never
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, replacement))
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)

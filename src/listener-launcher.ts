import { Clock, Crypto, Data, Effect, FileSystem, Path, Schema, Semaphore } from "effect"
import { ChildProcess } from "effect/process"
import { ListenerRequest, listenerArguments } from "./listener-request.ts"
import { makeListenerRegistry } from "./listeners.ts"
import { ensureBrowserInstalled, makeBrowserProfiles, type BrowserSelection } from "./browser-config.ts"

export class LaunchError extends Data.TaggedError("LaunchError")<{ readonly message: string }> {}

export const makeListenerLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const registry = yield* makeListenerRegistry()
  const browserProfiles = yield* makeBrowserProfiles()
  const entry = yield* path.fromFileUrl(new URL("./main.ts", import.meta.url))
  const lock = yield* Semaphore.make(1)
  const spawn = (args: string[], env: Record<string, string> = {}) => ChildProcess.make(process.execPath, [entry, ...args], {
    cwd: path.dirname(path.dirname(entry)), detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", env, extendEnv: true,
  })
  const launch = (input: ListenerRequest) => lock.withPermits(1)(Effect.scoped(Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(ListenerRequest)(input)
    const selection = yield* browserProfiles.resolveSelection(request.browser, request.profile || undefined)
    const status = yield* browserProfiles.status(selection)
    if (status.settingUp) return yield* new LaunchError({ message: "Close the account setup browser before starting a listener." })
    if (!status.ready) return yield* new LaunchError({ message: `Account '${selection.profile}' is not ready in ${selection.browser}. Use /setup, sign in, then close its window.` })
    yield* fs.makeDirectory(registry.root, { recursive: true, mode: 0o700 })
    const runId = yield* crypto.randomUUIDv4
    const child = yield* spawn(listenerArguments({ ...request, ...selection }), {
      TICKET_LISTENER_RUN_ID: runId, TICKET_LISTENERS_DIR: path.resolve(registry.root),
    })
    const deadline = (yield* Clock.currentTimeMillis) + 5000
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const row = (yield* registry.read).find((row) => row.runId === runId)
      if (row) {
        if (row.status === "failed") return yield* new LaunchError({ message: row.message.split("\n")[0]! })
        yield* child.unref
        return row
      }
      if (!(yield* child.isRunning)) return yield* new LaunchError({ message: "The listener exited before it could start. Run the command in a terminal to see its startup error." })
      yield* Effect.sleep("50 millis")
    }
    return yield* new LaunchError({ message: "The listener did not register within 5 seconds and was stopped. Check access to the listener directory and try again." })
  })))
  const setup = (selection: BrowserSelection) => lock.withPermits(1)(Effect.scoped(Effect.gen(function* () {
    const status = yield* browserProfiles.status(selection)
    if (status.settingUp) return yield* new LaunchError({ message: "This source is already open for setup. Sign in and close its window first." })
    yield* ensureBrowserInstalled(selection.browser)
    const child = yield* spawn(["profile", selection.profile, "--browser", selection.browser])
    const deadline = (yield* Clock.currentTimeMillis) + 10000
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const current = yield* browserProfiles.status(selection)
      if (!(yield* child.isRunning)) {
        if (Number(yield* child.exitCode) === 0 && current.ready) return
        return yield* new LaunchError({ message: current.setupError ?? `Could not open ${selection.browser} setup. Check that the source is closed; run profile ${selection.profile} --browser ${selection.browser} for details.` })
      }
      if (current.settingUp && current.setupOpened && current.setupPid === Number(child.pid)) {
        yield* child.unref
        return
      }
      yield* Effect.sleep("50 millis")
    }
    return yield* new LaunchError({ message: "Browser setup did not start within 10 seconds and was stopped." })
  })))
  return { launch, setup, browserProfiles }
})

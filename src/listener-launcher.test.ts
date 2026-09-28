import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, FileSystem, Path, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { isLive, makeListenerRegistry, type ListenerRecord } from "./listeners.ts"
import { makeBrowserProfiles } from "./browser-config.ts"
import { makeListenerLauncher } from "./listener-launcher.ts"

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ticket-background-" })
  const host = yield* path.fromFileUrl(new URL("./test-fixtures/launcher-host.ts", import.meta.url))
  const registry = yield* makeListenerRegistry(root)
  const waitFor = (predicate: (rows: ListenerRecord[]) => boolean) => registry.read.pipe(
    Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: predicate }), Effect.timeout("8 seconds"),
  )
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    const rows = yield* registry.read
    for (const row of rows.filter(isLive)) yield* registry.requestStop(row)
    if (rows.length) yield* waitFor((rows) => rows.every((row) => !isLive(row)))
  }).pipe(Effect.ignore))
  return { root, host, registry, waitFor }
})
const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | import("effect/Scope").Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)))

for (const mode of ["exit", "hangup"] as const) {
  test(`background listener survives launcher ${mode} and can be stopped from a fresh registry`, () => run(Effect.gen(function* () {
    const { root, host, registry, waitFor } = yield* setup
    const parent = yield* ChildProcess.make(process.execPath, [host], {
      env: { TICKET_LISTENERS_DIR: root, TICKET_BROWSER_HOME: `${root}/browsers`, TICKET_TEST_PARENT_WAIT: String(mode === "hangup") }, extendEnv: true,
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    })
    let rows = yield* waitFor((rows) => rows.some((row) => row.lastCheckAt !== undefined))
    if (mode === "exit") expect(Number(yield* parent.exitCode)).toBe(0)
    else yield* parent.kill({ killSignal: "SIGHUP" })
    const lastCheck = rows[0]!.lastCheckAt!
    rows = yield* waitFor((rows) => rows.some((row) => (row.lastCheckAt ?? 0) > lastCheck))
    expect(rows[0]!.status).toBe("waiting")
    const fresh = yield* makeListenerRegistry(root)
    yield* fresh.requestStop(rows[0]!)
    rows = yield* waitFor((rows) => rows.every((row) => row.status === "stopped"))
    expect(rows[0]!.status).toBe("stopped")
  })), 12000)
}

test("a saved source supports concurrent listeners", () => run(Effect.gen(function* () {
  const { root, host, waitFor } = yield* setup
  const parent = yield* ChildProcess.make(process.execPath, [host], {
    env: { TICKET_LISTENERS_DIR: root, TICKET_BROWSER_HOME: `${root}/browsers`, TICKET_TEST_COUNT: "2" }, extendEnv: true,
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  })
  expect(Number(yield* parent.exitCode)).toBe(0)
  const rows = yield* waitFor((rows) => rows.length === 2 && rows.every(isLive))
  expect(rows).toHaveLength(2)
})))

test("an unprepared source is rejected before spawning", () => run(Effect.gen(function* () {
  const { root } = yield* setup
  const result = yield* Effect.gen(function* () {
    const launcher = yield* makeListenerLauncher
    return yield* launcher.launch({ kind: "watch", url: "https://www.fnacspectacles.com/event/event-106/", every: 15, until: "", profile: "" })
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ ...process.env, TICKET_LISTENERS_DIR: root, TICKET_BROWSER_HOME: `${root}/browsers` })), Effect.result)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.message).toContain("/setup")
})))

for (const mode of ["exit", "hangup"] as const) {
  test(`source setup survives UI ${mode} and saves defaults only after close`, () => run(Effect.gen(function* () {
    const { root, host } = yield* setup
    const fs = yield* FileSystem.FileSystem
    const browserRoot = `${root}/browsers`
    const profiles = yield* makeBrowserProfiles(browserRoot)
    yield* Effect.addFinalizer(() => fs.writeFileString(`${browserRoot}/close-setup`, "close").pipe(Effect.ignore))
    const parent = yield* ChildProcess.make(process.execPath, [host], {
      env: { TICKET_LISTENERS_DIR: root, TICKET_BROWSER_HOME: browserRoot, TICKET_TEST_SETUP: "true", TICKET_TEST_PARENT_WAIT: String(mode === "hangup") }, extendEnv: true,
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    })
    const selection = { browser: "chrome", profile: "fixture" } as const
    yield* profiles.status(selection).pipe(Effect.repeat({ schedule: Schedule.spaced("30 millis"), until: (status) => status.setupOpened }), Effect.timeout("5 seconds"))
    if (mode === "exit") expect(Number(yield* parent.exitCode)).toBe(0)
    else yield* parent.kill({ killSignal: "SIGHUP" })
    const firstTick = yield* fs.readFileString(`${browserRoot}/setup-tick`)
    yield* fs.readFileString(`${browserRoot}/setup-tick`).pipe(Effect.repeat({ schedule: Schedule.spaced("30 millis"), until: (tick) => tick !== firstTick }), Effect.timeout("3 seconds"))
    expect((yield* profiles.readSettings).profile).toBe("default")
    yield* fs.writeFileString(`${browserRoot}/close-setup`, "close")
    yield* profiles.status(selection).pipe(Effect.repeat({ schedule: Schedule.spaced("30 millis"), until: (status) => status.ready }), Effect.timeout("3 seconds"))
    expect(yield* profiles.readSettings).toEqual(selection)
  })), 12000)
}

test("setup failure before the browser opens never reports successful handoff", () => run(Effect.gen(function* () {
  const { root, host } = yield* setup
  const child = yield* ChildProcess.make(process.execPath, [host], {
    env: { TICKET_LISTENERS_DIR: root, TICKET_BROWSER_HOME: `${root}/browsers`, TICKET_TEST_SETUP: "true", TICKET_TEST_SETUP_FAIL: "true" }, extendEnv: true,
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, code] = yield* Effect.all([child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.stderr.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], { concurrency: 3 })
  expect(Number(code)).not.toBe(0)
  expect(stdout + stderr).toContain("Controlled failure before browser opens")
})))

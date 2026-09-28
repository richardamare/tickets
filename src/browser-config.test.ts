import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, FileSystem, Path, Result, Scope } from "effect"
import { makeBrowserProfiles } from "./browser-config.ts"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)))
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ticket-browser-test-" })
  const profiles = yield* makeBrowserProfiles(root)
  return { fs, path, root, profiles }
})
const selection = { browser: "chrome", profile: "default" } as const

test("Chrome defaults and explicit Edge selections use persisted per-browser accounts", () => run(Effect.gen(function* () {
  const { profiles } = yield* setup
  expect(yield* profiles.readSettings).toEqual(selection)
  yield* profiles.saveSettings({ browser: "edge", profile: "work" })
  expect(yield* profiles.resolveSelection()).toEqual({ browser: "edge", profile: "work" })
  expect(yield* profiles.resolveSelection("chrome")).toEqual(selection)
  expect(yield* profiles.resolveSelection("chrome", "personal")).toEqual({ browser: "chrome", profile: "personal" })
})))

test("concurrent runs clone independently and remove only their own copies", () => run(Effect.gen(function* () {
  const { fs, path, profiles } = yield* setup
  const source = yield* Effect.scoped(Effect.gen(function* () {
    const source = yield* profiles.prepareSetup(selection)
    yield* fs.writeFileString(path.join(source, "session"), "original")
    yield* profiles.markReady(selection)
    return source
  }))
  const firstScope = yield* Scope.make()
  const secondScope = yield* Scope.make()
  const copies = yield* Effect.all([
    profiles.clone(selection).pipe(Scope.provide(firstScope)),
    profiles.clone(selection).pipe(Scope.provide(secondScope)),
  ], { concurrency: "unbounded" })
  expect(copies[0]).not.toBe(copies[1])
  yield* fs.writeFileString(path.join(copies[0]!, "session"), "changed")
  expect(yield* fs.readFileString(path.join(source, "session"))).toBe("original")
  expect(yield* fs.readFileString(path.join(copies[1]!, "session"))).toBe("original")
  yield* Scope.close(firstScope, Exit.void)
  expect(yield* fs.exists(copies[0]!)).toBe(false)
  expect(yield* fs.exists(copies[1]!)).toBe(true)
  expect(yield* fs.exists(source)).toBe(true)
  yield* Scope.close(secondScope, Exit.void)
  expect(yield* fs.exists(copies[1]!)).toBe(false)
})))

test("setup holds an exclusive lease and refuses cloning until the source is closed", () => run(Effect.gen(function* () {
  const { profiles } = yield* setup
  yield* Effect.scoped(Effect.gen(function* () {
    yield* profiles.prepareSetup(selection)
    expect(yield* profiles.status(selection)).toMatchObject({ ready: false, settingUp: true })
    const copy = yield* profiles.clone(selection).pipe(Effect.result)
    expect(Result.isFailure(copy)).toBe(true)
    if (Result.isFailure(copy)) expect(String(copy.failure)).toContain("locked")
    const secondSetup = yield* profiles.prepareSetup(selection).pipe(Effect.result)
    expect(Result.isFailure(secondSetup)).toBe(true)
    yield* profiles.markReady(selection)
  }))
  expect(yield* profiles.status(selection)).toMatchObject({ ready: true, settingUp: false })
  expect(yield* profiles.listProfiles("chrome")).toEqual(["default"])
})))

test("an externally opened source is never copied or unlocked", () => run(Effect.gen(function* () {
  const { fs, path, profiles } = yield* setup
  const source = yield* Effect.scoped(Effect.gen(function* () {
    const source = yield* profiles.prepareSetup(selection)
    yield* profiles.markReady(selection)
    return source
  }))
  const lock = path.join(source, "SingletonLock")
  yield* fs.symlink(`unverified-host-${process.pid}`, lock)
  const copy = yield* profiles.clone(selection).pipe(Effect.result)
  expect(Result.isFailure(copy)).toBe(true)
  expect(yield* fs.readLink(lock)).toBe(`unverified-host-${process.pid}`)
})))

test("absent sources fail with setup guidance and leave no runtime copy", () => run(Effect.gen(function* () {
  const { fs, path, root, profiles } = yield* setup
  const copy = yield* profiles.clone(selection).pipe(Effect.scoped, Effect.result)
  expect(Result.isFailure(copy)).toBe(true)
  if (Result.isFailure(copy)) expect(String(copy.failure)).toContain("/setup")
  expect(yield* fs.readDirectory(path.join(root, "runs"))).toEqual([])
})))

test("stale leases fail visibly and are never removed or reported as active setup", () => run(Effect.gen(function* () {
  const { fs, path, root, profiles } = yield* setup
  const lease = path.join(root, "chrome", "default", "lease")
  yield* fs.makeDirectory(lease, { recursive: true })
  yield* fs.writeFileString(path.join(lease, "owner.json"), JSON.stringify({ pid: 2147483647, token: "stale", operation: "setup" }))
  for (const operation of [profiles.status(selection).pipe(Effect.asVoid), profiles.prepareSetup(selection).pipe(Effect.asVoid)]) {
    const result = yield* operation.pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("stale")
  }
  expect(yield* fs.exists(lease)).toBe(true)
})))

test("setup acknowledges its owning process only after the browser opens and preserves failure details", () => run(Effect.gen(function* () {
  const { profiles } = yield* setup
  yield* Effect.scoped(Effect.gen(function* () {
    yield* profiles.prepareSetup(selection)
    expect(yield* profiles.status(selection)).toMatchObject({ setupPid: process.pid, setupOpened: false })
    yield* profiles.markSetupOpened(selection)
    expect(yield* profiles.status(selection)).toMatchObject({ setupPid: process.pid, setupOpened: true })
    yield* profiles.markSetupFailed(selection, "Chrome could not open its automation endpoint")
  }))
  expect(yield* profiles.status(selection)).toMatchObject({ ready: false, settingUp: false, setupOpened: false, setupError: "Chrome could not open its automation endpoint" })
})))

test("cleanup preserves a clone whose browser has not released its profile lock", () => run(Effect.gen(function* () {
  const { fs, path, profiles } = yield* setup
  yield* Effect.scoped(Effect.gen(function* () {
    yield* profiles.prepareSetup(selection)
    yield* profiles.markReady(selection)
  }))
  const cloneScope = yield* Scope.make()
  const copy = yield* profiles.clone(selection).pipe(Scope.provide(cloneScope))
  yield* fs.symlink(`unverified-host-${process.pid}`, path.join(copy, "SingletonLock"))
  yield* Scope.close(cloneScope, Exit.void)
  expect(yield* fs.exists(copy)).toBe(true)
  expect(yield* fs.readLink(path.join(copy, "SingletonLock"))).toBe(`unverified-host-${process.pid}`)
})))

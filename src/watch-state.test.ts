import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, FileSystem } from "effect"
import { makeWatchState } from "./watch-state.ts"

const snapshot = { lastGood: { event: "Concert", status: "sold_out" as const, categories: [] }, lastGoodAt: "2026-09-28T12:00:00Z" }
const run = <E>(f: (file: string) => Effect.Effect<void, E, BunServices.BunServices>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "watch-state-test-" })
  yield* f(`${dir}/watch.json`).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ HOME: dir, WATCH_STATE_FILE: `${dir}/watch.json` })))
})).pipe(Effect.provide(BunServices.layer)))

test("concurrent event snapshots preserve every event and browser account", () => run(() => Effect.gen(function* () {
  const chrome = yield* makeWatchState({ browser: "chrome", profileKey: "default" })
  const edge = yield* makeWatchState({ browser: "edge", profileKey: "default" })
  const named = yield* makeWatchState({ browser: "chrome", profileKey: "named:default" })
  yield* Effect.all([
    chrome.save("https://one.test", snapshot), chrome.save("https://two.test", snapshot),
    edge.save("https://one.test", { ...snapshot, lastFailure: "edge-only" }),
    named.save("https://one.test", { ...snapshot, lastFailure: "named-only" }),
  ], { concurrency: "unbounded" })
  expect(yield* chrome.load("https://one.test")).toEqual(snapshot)
  expect(yield* chrome.load("https://two.test")).toEqual(snapshot)
  expect((yield* edge.load("https://one.test")).lastFailure).toBe("edge-only")
  expect((yield* named.load("https://one.test")).lastFailure).toBe("named-only")
})))

test("same-event concurrent saves remain valid complete snapshots", () => run(() => Effect.gen(function* () {
  const state = yield* makeWatchState({ browser: "chrome", profileKey: "default" })
  yield* Effect.all(Array.from({ length: 15 }, (_, i) => state.save("https://one.test", { ...snapshot, lastFailure: String(i) })), { concurrency: "unbounded" })
  const saved = yield* state.load("https://one.test")
  expect(saved.lastGood).toEqual(snapshot.lastGood)
  expect(Number(saved.lastFailure)).toBeGreaterThanOrEqual(0)
})))

test("legacy WATCH_STATE_FILE imports only into the legacy Edge default account", () => run((file) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const legacy = JSON.stringify({ "https://one.test": snapshot })
  yield* fs.writeFileString(file, legacy)
  const edge = yield* makeWatchState({ browser: "edge", profileKey: "default" })
  const chrome = yield* makeWatchState({ browser: "chrome", profileKey: "default" })
  expect(yield* edge.load("https://one.test")).toEqual(snapshot)
  expect(yield* chrome.load("https://one.test")).toEqual({})
  yield* edge.save("https://one.test", { ...snapshot, lastFailure: "new" })
  expect((yield* edge.load("https://one.test")).lastFailure).toBe("new")
  expect(yield* fs.readFileString(file)).toBe(legacy)
})))

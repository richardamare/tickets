import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, FileSystem, Path, Schema } from "effect"
import { ListenerRecord, makeListenerRegistry, withListeners } from "./listeners.ts"

const input = { kind: "watch" as const, url: "https://www.fnacspectacles.com/event/concert-103/", profile: "default", everySeconds: 900 }
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ticket-listeners-" })
  const registry = yield* makeListenerRegistry(dir)
  return { fs, path, dir, registry }
})
const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | import("effect/Scope").Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)))

test("independent listeners publish live state without overwriting each other", () => run(Effect.gen(function* () {
  const { registry } = yield* setup
  const first = yield* registry.start(input)
  const second = yield* registry.start({ ...input, kind: "restock" })
  yield* first.update({ status: "waiting", message: "sold_out", lastCheckAt: 100, nextCheckAt: 900100 })
  yield* second.update({ status: "in_cart", message: "2 tickets held" })
  const rows = yield* registry.read
  expect(rows).toHaveLength(2)
  expect(rows.find((row) => row.kind === "watch")?.message).toBe("sold_out")
  expect(rows.find((row) => row.kind === "restock")?.status).toBe("in_cart")
  yield* first.close("stopped")
  yield* second.close("completed")
  expect((yield* registry.read).map((row) => row.status).sort()).toEqual(["completed", "stopped"])
})))

test("stale heartbeats are not presented as live listeners, corrupt files are skipped", () => run(Effect.gen(function* () {
  const { registry, fs, path, dir } = yield* setup
  const listener = yield* registry.start(input)
  yield* listener.close("completed")
  const row = (yield* registry.read)[0]!
  yield* fs.writeFileString(path.join(dir, `${row.id}.json`), yield* Schema.encodeEffect(Schema.fromJsonString(ListenerRecord))({ ...row, status: "waiting", heartbeatAt: 0 }))
  yield* fs.writeFileString(path.join(dir, "broken.json"), "{")
  yield* fs.writeFileString(path.join(dir, "wrong.json"), '{"id":"wrong","status":"waiting"}')
  expect((yield* registry.read).map((row) => row.status)).toEqual(["stale"])
})))

test("history is bounded and stopping clears the next check", () => run(Effect.gen(function* () {
  const { registry } = yield* setup
  const listener = yield* registry.start(input)
  for (let i = 0; i < 60; i++) yield* listener.update({ status: "waiting", message: `check ${i}`, nextCheckAt: 900100 })
  yield* listener.close("stopped")
  const row = (yield* registry.read)[0]!
  expect(row.history.length).toBeLessThanOrEqual(30)
  expect(row.nextCheckAt).toBeUndefined()
  expect(row.status).toBe("stopped")
})))

test("effect failures finalize listeners and preserve the reason", () => run(Effect.gen(function* () {
  const { registry, dir } = yield* setup
  yield* withListeners([input], () => Effect.fail(new Error("browser failed")), dir).pipe(Effect.ignore)
  const row = (yield* registry.read)[0]!
  expect(row.status).toBe("failed")
  expect(row.message).toContain("browser failed")
})))

test("registry write failure does not stop ticket monitoring", () => run(Effect.gen(function* () {
  const { fs, path, dir } = yield* setup
  const file = path.join(dir, "file")
  yield* fs.writeFileString(file, "not a directory")
  const registry = yield* makeListenerRegistry(file)
  const listener = yield* registry.start(input)
  yield* listener.update({ status: "checking", message: "still working" })
  yield* listener.close("completed")
})))

test("interrupting a run stops active listeners but preserves reached targets", () => run(Effect.gen(function* () {
  const { registry, dir } = yield* setup
  const ready = yield* Deferred.make<void>()
  const fiber = yield* withListeners([input, { ...input, url: "https://www.fnacspectacles.com/event/other-105/" }], ([first]) => Effect.gen(function* () {
    yield* first!.update({ status: "completed", message: "Target reached" })
    yield* Deferred.succeed(ready, undefined)
    yield* Effect.never
  }), dir).pipe(Effect.forkScoped)
  yield* Deferred.await(ready)
  yield* Fiber.interrupt(fiber)
  const rows = yield* registry.read
  expect(rows.find((row) => row.url === input.url)?.status).toBe("completed")
  expect(rows.find((row) => row.url.endsWith("other-105/"))?.status).toBe("stopped")
  const outcome = yield* registry.readRunOutcome(rows[0]!.runId!)
  expect(outcome._tag).toBe("Some")
  if (outcome._tag === "Some") expect(outcome.value.status).toBe("stopped")
})))

test("run completion is acknowledged only after resource teardown", () => run(Effect.gen(function* () {
  const { registry, dir } = yield* setup
  let cleanupFinished = false
  yield* withListeners([input], () => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      const row = (yield* registry.read)[0]!
      expect((yield* registry.readRunOutcome(row.runId!))._tag).toBe("None")
      cleanupFinished = true
    }).pipe(Effect.orDie))
    const row = (yield* registry.read)[0]!
    expect((yield* registry.readRunOutcome(row.runId!))._tag).toBe("None")
  }), dir)
  const row = (yield* registry.read)[0]!
  expect(cleanupFinished).toBe(true)
  const result = yield* registry.readRunOutcome(row.runId!)
  expect(result._tag).toBe("Some")
  if (result._tag === "Some") expect(result.value.status).toBe("completed")
})))

test("a stale heartbeat still permits a stop request without claiming shutdown", () => run(Effect.gen(function* () {
  const { fs, path, dir, registry } = yield* setup
  yield* registry.start(input)
  const row = (yield* registry.read)[0]!
  yield* fs.writeFileString(path.join(dir, `${row.id}.json`), yield* Schema.encodeEffect(Schema.fromJsonString(ListenerRecord))({ ...row, heartbeatAt: 0 }))
  const stale = (yield* registry.read)[0]!
  expect(stale.status).toBe("stale")
  yield* registry.requestStop(stale)
  expect(yield* fs.exists(path.join(dir, `${row.runId}.stop`))).toBe(true)
  expect((yield* registry.readRunOutcome(row.runId!))._tag).toBe("None")
})))

test("stop polling recovers after a transient filesystem error", () => run(Effect.gen(function* () {
  const { fs, dir } = yield* setup
  let attempts = 0
  const flaky = { ...fs, exists: (file: string) => Effect.suspend(() => file.endsWith(".stop") && attempts++ === 0 ? Effect.fail(new Error("temporary read failure")) : fs.exists(file)) } as typeof fs
  const registry = yield* makeListenerRegistry(dir).pipe(Effect.provideService(FileSystem.FileSystem, flaky))
  const listener = yield* registry.start(input)
  const row = (yield* registry.read)[0]!
  const polling = yield* registry.untilStopped.pipe(Effect.forkScoped)
  yield* Effect.sleep("50 millis")
  yield* registry.requestStop(row)
  const exit = yield* Fiber.await(polling).pipe(Effect.timeout("3 seconds"))
  expect(exit._tag).toBe("Failure")
  expect(attempts).toBeGreaterThanOrEqual(2)
  yield* listener.close("stopped")
})))

test("an archived listener disappears from every read while its record stays on disk", () => run(Effect.gen(function* () {
  const { fs, path, dir, registry } = yield* setup
  yield* registry.start(input)
  yield* registry.start({ ...input, url: "https://www.fnacspectacles.com/event/other-105/" })
  const [first, second] = yield* registry.read
  yield* registry.archive(first!)
  expect((yield* registry.read).map((row) => row.id)).toEqual([second!.id])
  expect(yield* fs.exists(path.join(dir, `${first!.id}.json`))).toBe(true)
})))

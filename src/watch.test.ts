import { expect, test } from "bun:test"
import { describeChanges } from "./watch.ts"
import type { Availability } from "./watch-state.ts"

const soldOut: Availability = {
  event: "Bjork",
  status: "sold_out",
  categories: [
    { name: "Cat 1", price: "89 EUR", status: "sold_out" },
    { name: "Cat 2", price: "59 EUR", status: "sold_out" },
  ],
}

test("identical availability has no changes", () => {
  expect(describeChanges(soldOut, soldOut)).toEqual([])
})

test("a category coming back on sale is reported with the status change", () => {
  const next: Availability = {
    ...soldOut,
    status: "on_sale",
    categories: [soldOut.categories[0]!, { name: "Cat 2", price: "59 EUR", status: "available" }],
  }
  expect(describeChanges(soldOut, next)).toEqual(["status sold_out → on_sale", "Cat 2: sold_out → available"])
})

test("price changes, new categories and removed categories are each reported", () => {
  const next: Availability = {
    ...soldOut,
    categories: [
      { name: "Cat 1", price: "99 EUR", status: "sold_out" },
      { name: "Pit", price: "120 EUR", status: "available" },
    ],
  }
  expect(describeChanges(soldOut, next)).toEqual([
    "Cat 1: price 89 EUR → 99 EUR",
    "new category Pit: available, 120 EUR",
    "category Cat 2 no longer listed",
  ])
})

const runWatchProbe = async (mode: "concurrent" | "failure") => {
  const { BunServices } = await import("@effect/platform-bun")
  const { Effect, Path } = await import("effect")
  const { ChildProcess } = await import("effect/unstable/process")
  const code = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const path = yield* Path.Path
    const fixture = yield* path.fromFileUrl(new URL("./test-fixtures/watch-worker.ts", import.meta.url))
    const child = yield* ChildProcess.make(process.execPath, [fixture], {
      stdin: "ignore", stdout: "ignore", stderr: "inherit", env: { TICKET_TEST_WATCH_MODE: mode }, extendEnv: true,
    })
    return yield* child.exitCode
  })).pipe(Effect.provide(BunServices.layer)))
  expect(Number(code)).toBe(0)
}

test("a successful check with failed persistence is reported as a failed run", () => runWatchProbe("failure"))
test("concurrent watch calls retain each event's last availability", () => runWatchProbe("concurrent"))

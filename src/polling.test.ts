import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Path } from "effect"
import { ChildProcess } from "effect/unstable/process"

for (const mode of ["watch", "restock"]) {
  test(`${mode} starts checks every 500ms including time spent checking`, async () => {
    const code = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const path = yield* Path.Path
      const fixture = yield* path.fromFileUrl(new URL("./test-fixtures/polling-worker.ts", import.meta.url))
      const child = yield* ChildProcess.make(process.execPath, [fixture, mode], { stdin: "ignore", stdout: "ignore", stderr: "inherit" })
      return yield* child.exitCode
    })).pipe(Effect.provide(BunServices.layer)))
    expect(Number(code)).toBe(0)
  })
}

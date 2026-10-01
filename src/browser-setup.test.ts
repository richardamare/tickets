import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Path, Stream } from "effect"
import { ChildProcess } from "effect/process"

for (const mode of ["ready", "settings"] as const) {
  test(`setup records ${mode} persistence failure without publishing readiness or replacing defaults`, async () => {
    const output = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const path = yield* Path.Path
      const fixture = yield* path.fromFileUrl(new URL("./test-fixtures/browser-setup-worker.ts", import.meta.url))
      const child = yield* ChildProcess.make(process.execPath, [fixture], { env: { TICKET_TEST_SETUP_FAILURE: mode }, extendEnv: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = yield* Effect.all([
        child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.stderr.pipe(Stream.decodeText(), Stream.mkString), child.exitCode,
      ], { concurrency: 3 })
      return { stdout, stderr, code: Number(code) }
    })).pipe(Effect.provide(BunServices.layer)))
    expect(output.stderr).toBe("")
    expect(output.code).toBe(0)
    expect(output.stdout).not.toContain("Saved Chrome account")
  })
}

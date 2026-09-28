import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { notifyUntilClicked, runCommand } from "./notifications.ts"

for (const [answer, exitCode, expected] of [["@CLOSED", 0, false], ["@ACTIONCLICKED", 0, true], ["", 1, undefined]] as const) {
  test(`notification result ${answer || "failure"} retains click semantics and removes its group`, async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ticket-notification-" })
      const notifier = path.join(root, "notifier")
      const removed = path.join(root, "removed")
      yield* fs.writeFileString(notifier, `#!/bin/sh\nif [ "$1" = "-remove" ]; then touch '${removed}'; exit 0; fi\nprintf '%s\\n' '${answer}'\nexit ${exitCode}\n`, { mode: 0o700 })
      expect(yield* notifyUntilClicked(notifier, "Title", "Message", "test")).toBe(expected)
      expect(yield* fs.exists(removed)).toBe(true)
    })).pipe(Effect.provide(BunServices.layer)))
  })
}

test("a nonzero notification helper exit is a failure", async () => {
  const result = await Effect.runPromise(runCommand("/usr/bin/false", []).pipe(Effect.result, Effect.provide(BunServices.layer)))
  expect(result._tag).toBe("Failure")
})

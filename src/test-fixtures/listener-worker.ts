import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Clock, Config, Effect, Schedule } from "effect"
import { withListeners } from "../listeners.ts"

Effect.gen(function* () {
  const fail = yield* Config.Boolean("TICKET_TEST_FAIL").pipe(Config.withDefault(false))
  yield* withListeners([{ kind: "watch", url: "https://www.fnacspectacles.com/event/background-test-104/", profile: "default", profileKey: "default", everySeconds: 5 }], ([listener]) =>
    fail ? Effect.fail(new Error("Controlled startup failure")) : Effect.gen(function* () {
      yield* listener!.update({ status: "waiting", message: "Background check", lastCheckAt: yield* Clock.currentTimeMillis })
    }).pipe(Effect.repeat(Schedule.spaced("100 millis"))),
  )
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)

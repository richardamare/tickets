import { Context, Data, Effect, Layer, Ref, type Schema } from "effect"

export class StateError extends Data.TaggedError("StateError")<{
  readonly key: string
  readonly reason: "missing" | "exists"
}> {
  override get message() {
    return this.reason === "missing"
      ? `No state entry "${this.key}"; create it with state_write`
      : `State entry "${this.key}" already exists; change it with state_update`
  }
}

export type StateEntries = Readonly<Record<string, Schema.Json>>

export class AgentState extends Context.Service<
  AgentState,
  {
    readonly read: (key: string) => Effect.Effect<Schema.Json, StateError>
    readonly snapshot: Effect.Effect<StateEntries>
    readonly write: (key: string, value: Schema.Json) => Effect.Effect<void, StateError>
    readonly update: (key: string, value: Schema.Json) => Effect.Effect<void, StateError>
  }
>()("AgentState") {
  static readonly layer = Layer.effect(
    AgentState,
    Effect.gen(function* () {
      const entries = yield* Ref.make<StateEntries>({})

      const change = (key: string, mustExist: boolean, value: Schema.Json) =>
        Ref.modify(entries, (current): [Effect.Effect<void, StateError>, StateEntries] =>
          Object.hasOwn(current, key) === mustExist
            ? [Effect.void, { ...current, [key]: value }]
            : [Effect.fail(new StateError({ key, reason: mustExist ? "missing" : "exists" })), current],
        ).pipe(Effect.flatten)

      return {
        read: (key) =>
          Ref.get(entries).pipe(
            Effect.flatMap((current) =>
              Object.hasOwn(current, key)
                ? Effect.succeed(current[key] as Schema.Json)
                : Effect.fail(new StateError({ key, reason: "missing" })),
            ),
          ),
        snapshot: Ref.get(entries),
        write: (key, value) => change(key, false, value),
        update: (key, value) => change(key, true, value),
      }
    }),
  )
}

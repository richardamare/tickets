import { Cause, Clock, Config, Crypto, Data, Effect, FileSystem, Option, Path, Schedule, Schema, Semaphore } from "effect"

const liveStatuses = ["starting", "checking", "waiting", "retrying", "blocked", "carting", "in_cart"] as const
const endedStatuses = ["completed", "stopped", "failed", "stale"] as const
export const ListenerRecord = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["watch", "restock"]),
  url: Schema.String,
  profile: Schema.String,
  browser: Schema.optionalKey(Schema.Literals(["chrome", "edge"])),
  profileKey: Schema.optionalKey(Schema.String),
  runId: Schema.optionalKey(Schema.String),
  everySeconds: Schema.Number,
  status: Schema.Literals([...liveStatuses, ...endedStatuses]),
  message: Schema.String,
  startedAt: Schema.Number,
  heartbeatAt: Schema.Number,
  lastCheckAt: Schema.optional(Schema.Number),
  nextCheckAt: Schema.optional(Schema.Number),
  browserPids: Schema.optional(Schema.Array(Schema.Number)),
  history: Schema.Array(Schema.Struct({ at: Schema.Number, message: Schema.String })),
})
export type ListenerRecord = typeof ListenerRecord.Type
export type ListenerInput = Pick<ListenerRecord, "kind" | "url" | "profile" | "profileKey" | "browser" | "everySeconds">
type Update = Partial<Pick<ListenerRecord, "status" | "message" | "lastCheckAt" | "nextCheckAt" | "browserPids">>
export interface Listener {
  readonly url: string
  readonly update: (update: Update) => Effect.Effect<void>
  readonly close: (status: "completed" | "stopped" | "failed", message?: string) => Effect.Effect<void>
}
const RecordJson = Schema.fromJsonString(ListenerRecord)
export const isLive = (row: ListenerRecord) => (liveStatuses as readonly string[]).includes(row.status)
const RunId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))
const RunOutcome = Schema.Struct({
  status: Schema.Literals(["completed", "stopped", "failed"]),
  endedAt: Schema.Number,
  message: Schema.optionalKey(Schema.String),
})
const RunOutcomeJson = Schema.fromJsonString(RunOutcome)
class ListenerControlError extends Data.TaggedError("ListenerControlError")<{ readonly message: string }> {}

export const makeListenerRegistry = (directory?: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const configured = yield* Config.String("TICKET_LISTENERS_DIR").pipe(Config.option)
  const root = directory ?? (Option.isSome(configured) ? configured.value : path.join(yield* Config.String("HOME"), ".ticket-scraper", "listeners"))
  const configuredRunId = yield* Config.String("TICKET_LISTENER_RUN_ID").pipe(Config.option)
  const runId = Option.isSome(configuredRunId) ? yield* Schema.decodeUnknownEffect(RunId)(configuredRunId.value) : yield* crypto.randomUUIDv4
  const stopFile = path.join(root, `${runId}.stop`)
  const readRunOutcome = (id: string) => Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(RunId)(id)
    const file = path.join(root, `${id}.ended`)
    if (!(yield* fs.exists(file))) return Option.none<typeof RunOutcome.Type>()
    return Option.some(yield* Schema.decodeEffect(RunOutcomeJson)(yield* fs.readFileString(file)))
  })
  const acknowledgeRun = (status: typeof RunOutcome.Type["status"], message?: string) => Effect.gen(function* () {
    const file = path.join(root, `${runId}.ended`)
    const temp = `${file}.${yield* crypto.randomUUIDv4}.tmp`
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(temp, yield* Schema.encodeEffect(RunOutcomeJson)({ status, ...(message === undefined ? {} : { message }), endedAt: yield* Clock.currentTimeMillis }), { mode: 0o600 }).pipe(
      Effect.andThen(fs.rename(temp, file)), Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)),
    )
  }).pipe(Effect.catch((error) => Effect.logWarning(`Cannot acknowledge listener shutdown: ${error.message}`)))

  const read = Effect.gen(function* () {
    if (!(yield* fs.exists(root))) return [] as ListenerRecord[]
    const files = yield* fs.readDirectory(root)
    const now = yield* Clock.currentTimeMillis
    // An archive marker sits beside the record, which its listener keeps rewriting while it runs.
    const archived = new Set(files.filter((file) => file.endsWith(".archived")).map((file) => file.slice(0, -".archived".length)))
    const records = yield* Effect.forEach(files.filter((file) => file.endsWith(".json") && !archived.has(file.slice(0, -".json".length))), (file) =>
      fs.readFileString(path.join(root, file)).pipe(
        Effect.flatMap(Schema.decodeEffect(RecordJson)),
        Effect.option,
      ),
    )
    return records.flatMap((entry): ListenerRecord[] => {
      if (Option.isNone(entry)) return []
      const row = entry.value
      return [isLive(row) && now - row.heartbeatAt >= 20000 ? { ...row, status: "stale", nextCheckAt: undefined } : row]
    }).sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.startedAt - a.startedAt || a.id.localeCompare(b.id))
  })

  const start = (input: ListenerInput) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const id = yield* crypto.randomUUIDv4
    const lock = yield* Semaphore.make(1)
    let record: ListenerRecord = { ...input, id, runId, status: "starting", message: "Starting", startedAt: now, heartbeatAt: now, history: [] }
    let closed = false
    let warned = false
    const file = path.join(root, `${id}.json`)
    const save = Effect.gen(function* () {
      record = { ...record, heartbeatAt: yield* Clock.currentTimeMillis }
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
      yield* fs.writeFileString(`${file}.tmp`, yield* Schema.encodeEffect(RecordJson)(record), { mode: 0o600 })
      yield* fs.rename(`${file}.tmp`, file)
    }).pipe(Effect.catch((error) => Effect.gen(function* () {
      if (!warned) yield* Effect.logWarning(`Cannot publish to the dashboard: ${error.message}`)
      warned = true
    })))
    const update = (update: Update) => lock.withPermits(1)(Effect.gen(function* () {
      if (closed) return
      const now = yield* Clock.currentTimeMillis
      record = {
        ...record, ...update,
        history: update.message === undefined ? record.history : [...record.history, { at: now, message: update.message }].slice(-30),
      }
      yield* save
    }))
    const close: Listener["close"] = (status, message) => lock.withPermits(1)(Effect.gen(function* () {
      if (closed) return
      if (isLive(record)) record = { ...record, status, message: message ?? (status === "completed" ? record.message : status), nextCheckAt: undefined }
      closed = true
      yield* save
    }))
    yield* save
    yield* Effect.addFinalizer((exit) => close(
      exit._tag === "Success" ? "completed" : Cause.hasInterruptsOnly(exit.cause) ? "stopped" : "failed",
      exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause) ? Cause.pretty(exit.cause) : undefined,
    ))
    yield* lock.withPermits(1)(Effect.suspend(() => closed ? Effect.void : save)).pipe(
      Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped,
    )
    return { url: input.url, update, close } satisfies Listener
  })
  const requestStop = (row: ListenerRecord) => Effect.gen(function* () {
    if (!row.runId || !Schema.is(RunId)(row.runId)) return yield* new ListenerControlError({ message: "This older listener must be stopped from its original terminal." })
    if ((!isLive(row) && row.status !== "stale") || Option.isSome(yield* readRunOutcome(row.runId))) return yield* new ListenerControlError({ message: "This listener is no longer active." })
    yield* fs.writeFileString(path.join(root, `${row.runId}.stop`), "stop", { mode: 0o600 })
  })
  const archive = (row: ListenerRecord) => Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(RunId)(row.id)
    yield* fs.writeFileString(path.join(root, `${row.id}.archived`), "archived", { mode: 0o600 })
  })
  const untilStopped = fs.exists(stopFile).pipe(
    Effect.catch((error) => Effect.logWarning(`Cannot read stop requests; retrying: ${error.message}`).pipe(Effect.as(false))),
    Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (requested) => requested }),
    Effect.andThen(Effect.interrupt),
  )
  const clearStop = fs.remove(stopFile, { force: true }).pipe(Effect.ignore)
  return { read, start, requestStop, archive, untilStopped, clearStop, readRunOutcome, acknowledgeRun, root }
})

export const withListeners = <A, E, R>(
  inputs: readonly ListenerInput[],
  run: (listeners: readonly Listener[]) => Effect.Effect<A, E, R>,
  directory?: string,
) => Effect.gen(function* () {
  const registry = yield* makeListenerRegistry(directory).pipe(Effect.option)
  if (Option.isNone(registry)) {
    yield* Effect.logWarning("Cannot register listeners; dashboard controls are unavailable")
    return yield* Effect.scoped(run([]))
  }
  return yield* Effect.scoped(Effect.gen(function* () {
    const listeners = yield* Effect.forEach(inputs, registry.value.start)
    return yield* run(listeners).pipe(Effect.raceFirst(registry.value.untilStopped))
  })).pipe(
    Effect.onExit((exit) => registry.value.acknowledgeRun(
      exit._tag === "Success" ? "completed" : Cause.hasInterruptsOnly(exit.cause) ? "stopped" : "failed",
      exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause) ? Cause.pretty(exit.cause) : undefined,
    )),
    Effect.ensuring(registry.value.clearStop),
  )
})

import { Config, Crypto, Data, Effect, FileSystem, Path, Schema } from "effect"

export const Availability = Schema.Struct({
  event: Schema.String,
  status: Schema.Literals(["on_sale", "sold_out", "not_yet_on_sale", "resale_only", "blocked", "unknown"]),
  categories: Schema.Array(Schema.Struct({ name: Schema.String, price: Schema.String, status: Schema.Literals(["available", "sold_out", "not_shown"]) })),
  note: Schema.optionalKey(Schema.String),
})
export type Availability = typeof Availability.Type
const Watched = Schema.Struct({
  lastGood: Schema.optionalKey(Availability),
  lastGoodAt: Schema.optionalKey(Schema.String),
  failingSince: Schema.optionalKey(Schema.String),
  lastFailure: Schema.optionalKey(Schema.String),
})
type Watched = typeof Watched.Type
const SnapshotJson = Schema.fromJsonString(Watched)
const LegacyJson = Schema.fromJsonString(Schema.Record(Schema.String, Watched))
const IdentityJson = Schema.fromJsonString(Schema.Array(Schema.String))
class WatchStateError extends Data.TaggedError("WatchStateError")<{ readonly message: string }> {}

export const makeWatchState = (account: { readonly browser: "chrome" | "edge"; readonly profileKey: string }) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const home = yield* Config.String("HOME")
  const legacyFile = yield* Config.String("WATCH_STATE_FILE").pipe(Config.withDefault(path.join(home, ".ticket-scraper", "watch.json")))
  const directory = `${legacyFile}.d`
  const fileFor = (url: string) => Effect.gen(function* () {
    const key = yield* Schema.encodeEffect(IdentityJson)([account.browser, account.profileKey, url])
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(key))
    return path.join(directory, `${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}.json`)
  })
  const load = (url: string) => Effect.gen(function* () {
    const file = yield* fileFor(url)
    if (yield* fs.exists(file)) {
      return yield* Schema.decodeEffect(SnapshotJson)(yield* fs.readFileString(file)).pipe(
        Effect.mapError((error) => new WatchStateError({ message: `${file} is not a valid watch snapshot: ${error.message}` })),
      )
    }
    if (account.browser !== "edge" || account.profileKey !== "default" || !(yield* fs.exists(legacyFile))) return {} as Watched
    const legacy = yield* Schema.decodeEffect(LegacyJson)(yield* fs.readFileString(legacyFile)).pipe(
      Effect.mapError((error) => new WatchStateError({ message: `${legacyFile} is not a valid legacy watch state file: ${error.message}` })),
    )
    return legacy[url] ?? {}
  })
  const save = (url: string, snapshot: Watched) => Effect.gen(function* () {
    const file = yield* fileFor(url)
    const temp = `${file}.${yield* crypto.randomUUIDv4}.tmp`
    const encoded = yield* Schema.encodeEffect(SnapshotJson)(snapshot)
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(temp, encoded, { mode: 0o600 }).pipe(
      Effect.andThen(fs.rename(temp, file)),
      Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)),
    )
  })
  return { load, save }
})

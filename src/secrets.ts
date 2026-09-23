import { Context, Data, Effect, Layer, Option, Redacted } from "effect"

const PREFIX = "SECRET_"
const ORIGINS_SUFFIX = "_ORIGINS"

export class SecretError extends Data.TaggedError("SecretError")<{
  readonly name: string
  readonly reason: "unknown" | "origin-not-allowed"
  readonly origin?: string
}> {
  override get message() {
    return this.reason === "unknown"
      ? `No secret named "${this.name}"; call list_secrets for the available names`
      : `Secret "${this.name}" may not be entered on ${this.origin}; it is limited to the origins shown by list_secrets`
  }
}

export type SecretInfo = {
  readonly name: string
  readonly origins: ReadonlyArray<string> | "any"
}

type Secret = SecretInfo & { readonly value: Redacted.Redacted<string> }

export class Secrets extends Context.Service<
  Secrets,
  {
    readonly list: ReadonlyArray<SecretInfo>
    readonly valueFor: (name: string, origin: string) => Effect.Effect<Redacted.Redacted<string>, SecretError>
  }
>()("Secrets") {
  // SECRET_<NAME>=value defines a secret; SECRET_<NAME>_ORIGINS=https://a.example,https://b.example pins it to those
  // origins. Without the pin a secret can be entered on any page, including one whose text tells the model to do so.
  static readonly layer = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const env = process.env
      const secrets = new Map<string, Secret>()
      for (const [key, raw] of Object.entries(env)) {
        if (!key.startsWith(PREFIX) || key.endsWith(ORIGINS_SUFFIX) || raw === undefined) continue
        const name = key.slice(PREFIX.length).toLowerCase()
        const pinned = env[`${key}${ORIGINS_SUFFIX}`]
        if (!pinned) {
          secrets.set(name, { name, origins: "any", value: Redacted.make(raw) })
          continue
        }
        const entries = pinned.split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0)
        const origins = entries.map((origin) => Option.liftThrowable(() => new URL(origin).origin)())
        const invalid = entries.filter((_, index) => Option.isNone(origins[index]!))
        // A pin that cannot be read drops the secret rather than widening it to every origin.
        if (invalid.length > 0) {
          yield* Effect.logWarning(`${key}${ORIGINS_SUFFIX} has invalid origins (${invalid.join(", ")}); secret "${name}" is unavailable`)
          continue
        }
        secrets.set(name, { name, origins: origins.flatMap(Option.toArray), value: Redacted.make(raw) })
      }

      return {
        list: [...secrets.values()].map(({ name, origins }) => ({ name, origins })),
        valueFor: (name, origin) => {
          const secret = secrets.get(name.toLowerCase())
          if (secret === undefined) return Effect.fail(new SecretError({ name, reason: "unknown" }))
          if (secret.origins !== "any" && !secret.origins.includes(origin)) {
            return Effect.fail(new SecretError({ name, reason: "origin-not-allowed", origin }))
          }
          return Effect.succeed(secret.value)
        },
      }
    }),
  )
}

import { AzureCliCredential, getBearerTokenProvider } from "@azure/identity"
import { Config, Context, Data, Effect, Layer } from "effect"
import { AzureOpenAI } from "openai"
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses"

export class FoundryError extends Data.TaggedError("FoundryError")<{
  readonly deployment: string
  readonly cause: unknown
}> {
  override get message() {
    return `Model ${this.deployment} request failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

export class Foundry extends Context.Service<
  Foundry,
  {
    readonly deployment: string
    readonly respond: (params: Omit<ResponseCreateParamsNonStreaming, "model">) => Effect.Effect<Response, FoundryError>
  }
>()("Foundry") {
  // Authenticates with the signed-in az CLI user; nothing secret lives in the repo or the environment.
  static readonly layer = Layer.effect(
    Foundry,
    Effect.gen(function* () {
      const endpoint = yield* Config.String("AZURE_OPENAI_ENDPOINT").pipe(
        Config.withDefault("https://foundry-amare-sandbox.cognitiveservices.azure.com/"),
      )
      const deployment = yield* Config.String("AZURE_OPENAI_DEPLOYMENT").pipe(Config.withDefault("gpt-5.1"))
      const apiVersion = yield* Config.String("AZURE_OPENAI_API_VERSION").pipe(Config.withDefault("2025-04-01-preview"))
      const tenantId = yield* Config.String("AZURE_TENANT_ID").pipe(
        Config.withDefault("97371585-85c1-4049-921c-7b8043f0d757"),
      )

      const client = new AzureOpenAI({
        endpoint,
        apiVersion,
        azureADTokenProvider: getBearerTokenProvider(
          new AzureCliCredential({ tenantId }),
          "https://cognitiveservices.azure.com/.default",
        ),
      })

      return {
        deployment,
        respond: (params) =>
          Effect.tryPromise({
            try: (signal) => client.responses.create({ ...params, model: deployment, stream: false }, { signal }),
            catch: (cause) => new FoundryError({ deployment, cause }),
          }),
      }
    }),
  )
}

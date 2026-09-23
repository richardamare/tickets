import { Context, Data, Effect, Layer, type Scope } from "effect"
import { chromium, type LaunchOptions, type Page } from "playwright"

export class BrowserError extends Data.TaggedError("BrowserError")<{
  readonly operation: string
  readonly cause: unknown
}> {
  override get message() {
    return `Browser ${this.operation} failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

const attempt = <A>(operation: string, f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new BrowserError({ operation, cause }) })

export class Browser extends Context.Service<
  Browser,
  {
    readonly newPage: Effect.Effect<Page, BrowserError, Scope.Scope>
    readonly withPage: <A>(operation: string, f: (page: Page) => Promise<A>) => Effect.Effect<A, BrowserError>
  }
>()("Browser") {
  static readonly layer = (options?: LaunchOptions) =>
    Layer.effect(
      Browser,
      Effect.gen(function* () {
        const browser = yield* Effect.acquireRelease(attempt("launch", () => chromium.launch(options)), (browser) =>
          attempt("close", () => browser.close()).pipe(Effect.ignore({ log: "Warn" })),
        )

        const newPage = Effect.acquireRelease(attempt("open page", () => browser.newContext()), (context) =>
          attempt("close page", () => context.close()).pipe(Effect.ignore({ log: "Warn" })),
        ).pipe(Effect.flatMap((context) => attempt("open page", () => context.newPage())))

        const withPage = <A>(operation: string, f: (page: Page) => Promise<A>) =>
          Effect.scoped(Effect.flatMap(newPage, (page) => attempt(operation, () => f(page))))

        return { newPage, withPage }
      }),
    )
}

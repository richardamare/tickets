import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { type SeatProvider, SeatProviders } from "./seats.ts"

const fake = (name: string, host: string): SeatProvider => ({
  name,
  matches: (url) => url.hostname === host,
  read: () => Effect.succeed([]),
})

const providerFor = (url: string, providers: ReadonlyArray<SeatProvider>) =>
  SeatProviders.use((registry) => registry.providerFor(url)).pipe(Effect.provide(SeatProviders.layer(providers)))

test("the first provider matching the URL is chosen", async () => {
  const chosen = await Effect.runPromise(providerFor("https://b.example/event/1", [fake("a", "a.example"), fake("b", "b.example")]))
  expect(chosen.provider.name).toBe("b")
})

test("an unsupported site or a malformed URL fails with the reason", async () => {
  const unsupported = await Effect.runPromiseExit(providerFor("https://c.example/", [fake("a", "a.example")]))
  expect(Exit.isFailure(unsupported) && String(unsupported.cause)).toContain("no seat provider handles c.example; supported: a")
  const malformed = await Effect.runPromiseExit(providerFor("not a url", [fake("a", "a.example")]))
  expect(Exit.isFailure(malformed) && String(malformed.cause)).toContain("not a url is not a URL")
})

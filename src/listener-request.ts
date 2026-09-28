import { Schema } from "effect"
import { BrowserKind } from "./browser-config.ts"
import { eventIdOf, eventim } from "./providers/eventim.ts"

export const WatchUrl = Schema.String.check(Schema.makeFilter((value) => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password } catch { return false }
}))
export const RestockUrl = WatchUrl.check(Schema.makeFilter((value) => {
  const url = new URL(value)
  return eventim.matches(url) && eventIdOf(url) !== undefined
}))
export const CheckInterval = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0.5), Schema.isLessThanOrEqualTo(1000000))
export const TicketQuantity = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))
export const ProfileName = Schema.String.check(Schema.makeFilter((value) => value === "" || (value !== "." && value !== ".." && /^[a-zA-Z0-9._-]+$/.test(value))))
export const WatchUntil = Schema.Literals(["", "on_sale", "sold_out", "not_yet_on_sale", "resale_only"])
export const TicketOrder = Schema.Literals(["cheapest", "most-free"])
export const defaults = { watchEvery: 0.5, restockEvery: 0.5, quantity: 1, prefer: "cheapest" } as const
export const ListenerRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("watch"), url: RestockUrl, every: CheckInterval, until: WatchUntil, profile: ProfileName, browser: Schema.optional(BrowserKind) }),
  Schema.Struct({ kind: Schema.Literal("restock"), url: RestockUrl, every: CheckInterval, quantity: TicketQuantity, prefer: Schema.optional(TicketOrder), profile: ProfileName, browser: Schema.optional(BrowserKind) }),
])
export type ListenerRequest = typeof ListenerRequest.Type
export const listenerArguments = (request: ListenerRequest): string[] => [
  request.kind, request.url, "--every", String(request.every),
  ...(request.kind === "restock" ? ["--quantity", String(request.quantity), ...(request.prefer ? ["--prefer", request.prefer] : [])] : request.until ? ["--until", request.until] : []),
  ...(request.profile ? ["--profile", request.profile] : []),
  ...(request.browser ? ["--browser", request.browser] : []),
]

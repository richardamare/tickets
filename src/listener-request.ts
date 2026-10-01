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
export const TabCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(8))
export const CartRefreshes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10))
export const defaults = { watchEvery: 0.5, restockEvery: 0.5, quantity: 1, prefer: "cheapest", tabs: 3, cartRefreshes: 2 } as const
export const ListenerRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("watch"), url: RestockUrl, every: CheckInterval, until: WatchUntil, profile: ProfileName, browser: Schema.optional(BrowserKind) }),
  Schema.Struct({ kind: Schema.Literal("restock"), url: RestockUrl, every: CheckInterval, quantity: TicketQuantity, prefer: Schema.optional(TicketOrder), tabs: Schema.optional(TabCount), cartRefreshes: Schema.optional(CartRefreshes), profile: ProfileName, browser: Schema.optional(BrowserKind) }),
])
export type ListenerRequest = typeof ListenerRequest.Type
export const listenerArguments = (request: ListenerRequest): string[] => [
  request.kind, request.url, "--every", String(request.every),
  ...(request.kind === "restock"
    ? [
        "--quantity", String(request.quantity),
        ...(request.prefer ? ["--prefer", request.prefer] : []),
        ...(request.tabs !== undefined ? ["--tabs", String(request.tabs)] : []),
        ...(request.cartRefreshes !== undefined ? ["--cart-refreshes", String(request.cartRefreshes)] : []),
      ]
    : request.until ? ["--until", request.until] : []),
  ...(request.profile ? ["--profile", request.profile] : []),
  ...(request.browser ? ["--browser", request.browser] : []),
]

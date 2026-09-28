import { Schema } from "effect"

import { RestockUrl as restockUrl, CheckInterval as interval, TicketQuantity as quantity, ProfileName as profile, ListenerRequest, defaults } from "./listener-request.ts"
import type { BrowserSelection } from "./browser-config.ts"

export interface ListenerForm {
  readonly kind: "watch" | "restock"
  readonly step: "url" | "quantity" | "prefer" | "every" | "until" | "profile" | "review"
  readonly url: string
  readonly quantity: number
  readonly prefer: "cheapest" | "most-free"
  readonly every: number
  readonly until: "" | "on_sale" | "sold_out" | "not_yet_on_sale" | "resale_only"
  readonly browser?: BrowserSelection["browser"]
  readonly profile: string
}
export const startForm = (kind: ListenerForm["kind"], selection?: BrowserSelection): ListenerForm => ({ kind, step: "url", url: "", quantity: defaults.quantity, prefer: defaults.prefer, every: kind === "watch" ? defaults.watchEvery : defaults.restockEvery, until: "", profile: selection?.profile ?? "", ...(selection ? { browser: selection.browser } : {}) })
export const formQuestion = (form: ListenerForm) => {
  switch (form.step) {
    case "url": return { label: "Paste the event link", hint: form.kind === "restock" ? "A Fnac Spectacles event page. Tickets are reserved automatically; you pay in the browser." : "An event page to monitor. We notify you when availability changes.", defaultValue: "" }
    case "quantity": return { label: "How many tickets would you like?", hint: "Above the site's limit per order, another browser opens for each further cart.", defaultValue: String(form.quantity) }
    case "prefer": return { label: "Which tickets first?", hint: "1 Cheapest · 2 Category with the most free tickets", defaultValue: form.prefer === "cheapest" ? "1" : "2" }
    case "every": return { label: "How often should we check? (seconds)", hint: "Minimum 0.5 seconds. Press Enter to keep the suggested value.", defaultValue: String(form.every) }
    case "until": return { label: "When should watching stop?", hint: "1 Keep watching · 2 Tickets on sale · 3 Sold out · 4 Sale not open · 5 Resale only", defaultValue: String(["", "on_sale", "sold_out", "not_yet_on_sale", "resale_only"].indexOf(form.until) + 1) }
    case "profile": return { label: "Which browser account?", hint: "Reusable signed-in sources. Each run gets an isolated copy.", defaultValue: form.profile }
    case "review": return { label: "Ready to start?", hint: "Enter starts in the background. Esc cancels. Ctrl+B goes back.", defaultValue: "Start" }
  }
}
export const formSummary = (form: ListenerForm) => [
  `${form.kind === "watch" ? "Watch availability" : "Reserve tickets when available"}: ${form.url}`,
  `Every ${form.every} seconds · ${form.browser ?? "saved browser"} · source: ${form.profile || "Default account"}`,
  form.kind === "restock" ? `Up to ${form.quantity} ticket(s), ${form.prefer === "cheapest" ? "cheapest" : "most available"} first. Pay manually in each browser; every cart hold is limited.` : `Stop: ${{ "": "keep watching", on_sale: "tickets go on sale", sold_out: "sold out", not_yet_on_sale: "sale not open", resale_only: "resale only" }[form.until]}`,
  "Keeps running when you close this UI or terminal.",
]
export const previousStep = (form: ListenerForm): ListenerForm => {
  const steps: readonly ListenerForm["step"][] = form.kind === "watch" ? ["url", "every", "until", "profile", "review"] : ["url", "quantity", "prefer", "every", "profile", "review"]
  return { ...form, step: steps[Math.max(0, steps.indexOf(form.step) - 1)]! }
}
export const submitForm = (form: ListenerForm, raw: string): { form: ListenerForm; request?: ListenerRequest; error?: string } => {
  const value = raw.trim()
  const invalid = (error: string) => ({ form, error })
  switch (form.step) {
    case "url":
      if (!Schema.is(restockUrl)(value)) return invalid("Paste a valid Fnac Spectacles event link (https://…/event/123/ or https://…/event/name-123/).")
      return { form: { ...form, url: value, step: form.kind === "restock" ? "quantity" : "every" } }
    case "quantity": {
      const count = Number(value || form.quantity)
      if (!Schema.is(quantity)(count)) return invalid("Enter a whole number of tickets from 1 to 100.")
      return { form: { ...form, quantity: count, step: "prefer" } }
    }
    case "prefer": {
      const choice = value || (form.prefer === "cheapest" ? "1" : "2")
      if (choice !== "1" && choice !== "2") return invalid("Choose 1 Cheapest or 2 Most free tickets.")
      return { form: { ...form, prefer: choice === "1" ? "cheapest" : "most-free", step: "every" } }
    }
    case "every": {
      const every = Number(value || form.every)
      if (!Schema.is(interval)(every)) return invalid("Enter a number from 0.5 to 1000000 seconds.")
      return { form: { ...form, every, step: form.kind === "watch" ? "until" : "profile" } }
    }
    case "until": {
      const choices = ["", "on_sale", "sold_out", "not_yet_on_sale", "resale_only"] as const
      const choice = Number(value || String(choices.indexOf(form.until) + 1))
      if (!Number.isInteger(choice) || choice < 1 || choice > choices.length) return invalid("Choose 1, 2, 3, 4 or 5.")
      return { form: { ...form, until: choices[choice - 1]!, step: "profile" } }
    }
    case "profile":
      if (!Schema.is(profile)(value)) return invalid("Choose a saved account name using letters, numbers, dots, underscores or hyphens.")
      return { form: { ...form, profile: value, step: "review" } }
    case "review": {
      if (value && value.toLowerCase() !== "start") return invalid("Press Enter to start, or Esc to cancel.")
      const request = form.kind === "watch"
        ? { kind: form.kind, url: form.url, every: form.every, until: form.until, profile: form.profile, ...(form.browser ? { browser: form.browser } : {}) }
        : { kind: form.kind, url: form.url, every: form.every, quantity: form.quantity, prefer: form.prefer, profile: form.profile, ...(form.browser ? { browser: form.browser } : {}) }
      return { form, request: Schema.decodeUnknownSync(ListenerRequest)(request) }
    }
  }
}

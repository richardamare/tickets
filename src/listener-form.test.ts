import { expect, test } from "bun:test"
import { startForm, submitForm, formQuestion, type ListenerForm } from "./listener-form.ts"
import { listenerArguments } from "./listener-request.ts"

const answer = (form: ListenerForm, value: string) => {
  const result = submitForm(form, value)
  if (result.error) throw new Error(result.error)
  return result
}

test("watch guides a user through defaults to a review before starting", () => {
  let form = startForm("watch")
  expect(formQuestion(form).label).toContain("event link")
  form = answer(form, "https://www.fnacspectacles.com/event/concert-103/").form
  expect(formQuestion(form).label).toContain("seconds")
  form = answer(form, "").form
  form = answer(form, "1").form
  form = answer(form, "").form
  expect(form.step).toBe("review")
  expect(submitForm(form, "").request).toEqual({ kind: "watch", url: "https://www.fnacspectacles.com/event/concert-103/", every: 0.5, until: "", profile: "" })
})

test("restock refuses unsupported sites and invalid ticket counts without advancing", () => {
  const form = startForm("restock")
  expect(submitForm(form, "https://example.com/concert").error).toContain("Fnac")
  const tickets = answer(form, "https://www.fnacspectacles.com/event/show-12345/").form
  expect(submitForm(tickets, "0").form.step).toBe("quantity")
  expect(submitForm(tickets, "1.5").error).toBeDefined()
  expect(submitForm(tickets, "two").error).toBeDefined()
})

test("both modes accept half-second checks and reject shorter intervals and non-http URLs", () => {
  expect(submitForm(startForm("watch"), "file:///tmp/test").error).toBeDefined()
  let watch = answer(startForm("watch"), "https://www.fnacspectacles.com/event/concert-103/").form
  expect(submitForm(watch, "0.4").error).toContain("0.5")
  expect(answer(watch, "0.5").form.every).toBe(0.5)
  let restock = answer(startForm("restock"), "https://fnacspectacles.com/event/show-123/").form
  restock = answer(restock, "2").form
  restock = answer(restock, "").form
  restock = answer(restock, "").form
  restock = answer(restock, "").form
  expect(formQuestion(restock).defaultValue).toBe("0.5")
  expect(submitForm(restock, "0.4").error).toContain("0.5")
  expect(answer(restock, "0.5").form.every).toBe(0.5)
  expect(formQuestion(restock).label).toContain("seconds")
})

test("listener arguments preserve URL characters without shell interpretation", () => {
  const url = "https://www.fnacspectacles.com/event/concert-103/?q=$(touch%20/tmp/nope)&a=1"
  expect(listenerArguments({ kind: "watch", url, every: 15, until: "on_sale", profile: "alice" })).toEqual([
    "watch", url, "--every", "15", "--until", "on_sale", "--profile", "alice",
  ])
  expect(listenerArguments({ kind: "restock", url: "https://fnacspectacles.com/event/show-123/", every: 10, quantity: 2, profile: "" })).toEqual([
    "restock", "https://fnacspectacles.com/event/show-123/", "--every", "10", "--quantity", "2",
  ])
})

test("both listener modes freeze the selected browser and profile through review", () => {
  for (const kind of ["watch", "restock"] as const) {
    const form = { ...startForm(kind, { browser: "edge", profile: "alice" }), step: "review" as const, url: "https://fnacspectacles.com/event/show-123/" }
    const request = submitForm(form, "").request!
    expect(request.browser).toBe("edge")
    expect(request.profile).toBe("alice")
    expect(listenerArguments(request).slice(-4)).toEqual(["--profile", "alice", "--browser", "edge"])
  }
})

test("restock asks which tickets to try first, defaults to the cheapest and passes the choice on", () => {
  let form = answer(startForm("restock"), "https://fnacspectacles.com/event/show-123/").form
  form = answer(form, "50").form
  expect(form.step).toBe("prefer")
  expect(formQuestion(form).defaultValue).toBe("1")
  expect(submitForm(form, "3").error).toContain("Cheapest")
  expect(answer(form, "").form.prefer).toBe("cheapest")
  form = answer(form, "2").form
  expect(form.prefer).toBe("most-free")
  form = answer(answer(answer(answer(form, "").form, "").form, "").form, "").form
  const { request } = submitForm(form, "")
  expect(request && listenerArguments(request)).toContain("most-free")
  expect(request && listenerArguments(request)).toContain("50")
})

test("restock asks for tabs and cart refreshes, validates them and passes them on as flags", () => {
  let form = answer(startForm("restock"), "https://fnacspectacles.com/event/show-123/").form
  form = answer(answer(form, "2").form, "").form
  expect(form.step).toBe("tabs")
  expect(formQuestion(form).defaultValue).toBe("3")
  for (const wrong of ["0", "9", "2.5", "many"]) expect(submitForm(form, wrong).error).toContain("1 to 8")
  form = answer(form, "5").form
  expect(form.step).toBe("refreshes")
  expect(formQuestion(form).defaultValue).toBe("2")
  for (const wrong of ["-1", "11", "1.5"]) expect(submitForm(form, wrong).error).toContain("0 to 10")
  form = answer(form, "0").form
  expect(form.step).toBe("every")
  form = answer(answer(form, "").form, "").form
  const { request } = submitForm(form, "")
  expect(request && listenerArguments(request)).toEqual([
    "restock", "https://fnacspectacles.com/event/show-123/", "--every", "0.5", "--quantity", "2", "--prefer", "cheapest", "--tabs", "5", "--cart-refreshes", "0",
  ])
})

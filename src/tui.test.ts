import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Fiber, FileSystem, Option, Path, Queue, Schedule, Stdio, Terminal } from "effect"
import { BunServices } from "@effect/platform-bun"
import { makeListenerRegistry } from "./listeners.ts"
import { formQuestion, startForm } from "./listener-form.ts"
import type { ListenerRecord } from "./listeners.ts"
import { dashboard, renderDashboard } from "./tui.ts"
import { initialView, handleKey, visibleListeners } from "./tui-prompt.ts"

const row: ListenerRecord = {
  id: "first", kind: "watch", url: "https://www.fnacspectacles.com/event/bjork-101/", profile: "default",
  everySeconds: 900, status: "waiting", message: "Bjork: sold_out", startedAt: 1000, heartbeatAt: 1000,
  lastCheckAt: 1000, nextCheckAt: 901000, history: [{ at: 1000, message: "Bjork: sold_out" }],
}
const key = (name: string, input?: string) => ({ key: { name, ctrl: false, meta: false, shift: false }, input: Option.fromUndefinedOr(input) })
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

test("listener details display the half-second interval without rounding to zero", () => {
  const screen = plain(renderDashboard([{ ...row, everySeconds: 0.5 }], { ...initialView, expanded: true }, { columns: 110, rows: 32, now: 2000 }))
  expect(screen).toContain("every 0.5s")
})

test("keyboard navigation, inline details and filter share the selected listener", () => {
  const rows = [row, { ...row, id: "second", profile: "alice", url: "https://www.fnacspectacles.com/event/muse-102/" }]
  let view = handleKey(initialView, key("down"), rows)
  expect(view.selectedId).toBe("second")
  view = handleKey(view, key("return"), rows)
  expect(view.expanded).toBe(true)
  for (const letter of "/filter") view = handleKey(view, key(letter, letter), rows)
  view = handleKey(view, key("return"), rows)
  for (const letter of "alice") view = handleKey(view, key(letter, letter), rows)
  expect(visibleListeners(rows, view).map((r) => r.id)).toEqual(["second"])
  view = handleKey(view, key("escape"), rows)
  expect(view.query).toBe("")
  expect(view.filtering).toBe(false)
})

test("live-only toggle excludes history and stale processes", () => {
  const rows = [row, { ...row, id: "old", status: "stale" as const }]
  let view = initialView
  for (const letter of "/active") view = handleKey(view, key(letter, letter), rows)
  view = handleKey(view, key("return"), rows)
  expect(visibleListeners(rows, view).map((r) => r.id)).toEqual(["first"])
})

test("layout stays inside terminal bounds and escapes event-provided terminal controls", () => {
  const hostile = { ...row, message: "sold out\x1b[2J\r\nFAKE\x1b]0;bad\x07" }
  const screen = renderDashboard([hostile], { ...initialView, expanded: true }, { columns: 80, rows: 24, now: 2000 })
  expect(screen).not.toContain("\x1b[2J")
  expect(screen).not.toContain("\x1b]0;")
  const lines = plain(screen).split("\r\n")
  expect(lines.length).toBeLessThanOrEqual(24)
  expect(lines.every((line) => Bun.stringWidth(line) <= 79)).toBe(true)
  expect(plain(screen)).toContain("Ticket Scraper")
  expect(plain(screen)).toContain("sold out")
})

test("empty dashboard tells the user how to start a listener", () => {
  const screen = plain(renderDashboard([], initialView, { columns: 110, rows: 28, now: 2000 }))
  expect(screen).toContain("/watch")
  expect(screen).toContain("/restock")
  expect(screen).toContain("? for shortcuts")
  expect(screen).not.toContain("Ctrl+")
})

test("? on an empty prompt opens every shortcut and ? again closes them", () => {
  let view = handleKey(initialView, key("", "?"), [row])
  expect(view.help).toBe(true)
  expect(view.input).toBe("")
  const screen = plain(renderDashboard([row], view, { columns: 110, rows: 32, now: 2000 }))
  for (const shortcut of ["Ctrl+X Ctrl+X", "Ctrl+X ", "Ctrl+C", "Ctrl+B", "Ctrl+U", "Home/End", "PgUp/PgDn", "Tab", "Esc"]) expect(screen).toContain(shortcut)
  view = handleKey(view, key("", "?"), [row])
  expect(view.help).toBe(false)
})

test("? typed inside a URL stays in the prompt", () => {
  let view = handleKey(initialView, key("", "/watch"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("", "https://www.fnacspectacles.com/event/x-1/?a"), [])
  view = handleKey(view, key("", "?"), [])
  expect(view.help).toBe(false)
  expect(view.input.endsWith("?")).toBe(true)
})

test("slash prompt completes commands and queues a launch only after review", () => {
  let view = handleKey(initialView, key("", "/wa"), [])
  view = handleKey(view, key("tab"), [])
  expect(view.input).toBe("/watch")
  view = handleKey(view, key("return"), [])
  expect(view.form?.step).toBe("url")
  view = handleKey(view, key("", "https://www.fnacspectacles.com/event/concert-103/"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("return"), [])
  expect(view.form?.step).toBe("review")
  expect(view.pendingRequest).toBeUndefined()
  view = handleKey(view, key("return"), [])
  expect(view.pendingRequest?.kind).toBe("watch")
})

test("letters in prompt never trigger list shortcuts or quit", () => {
  let view = initialView
  for (const letter of "qjak") view = handleKey(view, key(letter, letter), [row])
  expect(view.input).toBe("qjak")
  expect(view.quit).toBe(false)
  expect(view.liveOnly).toBe(false)
})

test("stop requires confirmation and escape leaves the listener running", () => {
  let view = handleKey(initialView, key("", "/stop"), [row])
  view = handleKey(view, key("return"), [row])
  expect(view.stopTarget).toBe(row.id)
  expect(view.pendingStop).toBeUndefined()
  view = handleKey(view, key("escape"), [row])
  expect(view.stopTarget).toBeUndefined()
  expect(view.pendingStop).toBeUndefined()
})

test("going back preserves the chosen account and stop condition", () => {
  let view = handleKey(initialView, key("", "/watch https://www.fnacspectacles.com/event/concert-103/"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("2", "2"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("", "alice"), [])
  view = handleKey(view, key("return"), [])
  const back = { ...key("b"), key: { ...key("b").key, ctrl: true } }
  view = handleKey(view, back, [])
  view = handleKey(view, key("return"), [])
  expect(view.form?.profile).toBe("alice")
  view = handleKey(view, back, [])
  view = handleKey(view, back, [])
  view = handleKey(view, key("return"), [])
  expect(view.form?.until).toBe("on_sale")
})

test("guided prompts fit in small terminals and keep the current question visible", () => {
  let view = handleKey(initialView, key("", "/watch https://www.fnacspectacles.com/event/concert-103/"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("return"), [])
  const screen = plain(renderDashboard([], view, { columns: 60, rows: 18, now: 2000 }))
  expect(screen.split("\r\n").length).toBeLessThanOrEqual(17)
  expect(screen).toContain("When should watching stop?")
  expect(screen).toContain("[1]")
})

test("refresh errors remain visible beneath persistent notices", () => {
  const screen = plain(renderDashboard([], { ...initialView, notice: "Listener started." }, { columns: 80, rows: 24, now: 0, error: "Permission denied" }))
  expect(screen).toContain("Cannot refresh: Permission denied")
  expect(screen).toContain("Listener started.")
})

test("the minimum supported terminal preserves every current question", () => {
  for (const step of ["url", "quantity", "every", "until", "profile", "review"] as const) {
    const form = { ...startForm("restock"), step }
    const screen = plain(renderDashboard([], { ...initialView, form }, { columns: 46, rows: 13, now: 0 }))
    expect(screen.split("\r\n")).toHaveLength(12)
    expect(screen).toContain(formQuestion(form).label.slice(0, 35))
  }
})

test("setup chooses browser and reusable source without launching a listener", () => {
  let view = handleKey(initialView, key("", "/setup"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("", "2"), [])
  view = handleKey(view, key("return"), [])
  view = handleKey(view, key("", "tickets"), [])
  view = handleKey(view, key("return"), [])
  expect(view.pendingSetup).toEqual({ browser: "edge", profile: "tickets" })
  expect(view.pendingRequest).toBeUndefined()
})

test("dashboard service waits for durable teardown acknowledgement when a listener is stale", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "dashboard-stop-" })
    const registry = yield* makeListenerRegistry(root)
    const listener = yield* registry.start({ kind: "watch", url: row.url, profile: "default", everySeconds: 900 })
    const current = (yield* registry.read)[0]!
    yield* fs.writeFileString(path.join(root, `${current.id}.json`), JSON.stringify({ ...current, heartbeatAt: 0 }))
    const input = yield* Queue.make<Terminal.UserInput>()
    const screens: string[] = []
    const terminal = Terminal.make({ columns: Effect.succeed(100), rows: Effect.succeed(25), readInput: Effect.succeed(input), readLine: Effect.succeed(""), display: (text) => Effect.sync(() => { screens.push(plain(text)) }) })
    const waitScreen = (text: string) => Effect.sync(() => screens.at(-1)?.includes(text) ?? false).pipe(Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: Boolean }), Effect.timeout("4 seconds"))
    const fiber = yield* dashboard.pipe(
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provide(Stdio.layerTest({ stdinIsTerminal: Effect.succeed(true), stdoutIsTerminal: Effect.succeed(true) })),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ ...process.env, TICKET_LISTENERS_DIR: root, TICKET_BROWSER_HOME: path.join(root, "browsers") })),
      Effect.forkScoped,
    )
    yield* waitScreen("Ticket Scraper")
    yield* Queue.offer(input, key("", "/stop"))
    yield* Queue.offer(input, key("return"))
    yield* waitScreen("Press Enter to stop")
    yield* Queue.offer(input, key("return"))
    yield* waitScreen("Stop requested.")
    yield* Effect.sleep("1100 millis")
    expect(screens.at(-1)).not.toContain("Listener stopped.")
    expect(yield* fs.exists(path.join(root, `${current.runId}.stop`))).toBe(true)
    yield* listener.close("stopped")
    yield* registry.acknowledgeRun("stopped")
    yield* waitScreen("Listener stopped.")
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)))
})

const ctrlX = { key: { name: "x", ctrl: true, meta: false, shift: false }, input: Option.none() }

test("Ctrl+X stops the selected listener and a second Ctrl+X within the window archives it", () => {
  const rows = [row, { ...row, id: "second" }]
  let view = handleKey(initialView, key("down"), rows)
  view = handleKey(view, ctrlX, rows, [], undefined, 10_000)
  expect(view.pendingStop).toBe("second")
  expect(view.pendingArchive).toBeUndefined()
  view = handleKey({ ...view, pendingStop: undefined }, ctrlX, rows, [], undefined, 10_400)
  expect(view.pendingArchive).toBe("second")
})

test("Ctrl+X pressed again after the window stops again instead of archiving", () => {
  let view = handleKey(initialView, ctrlX, [row], [], undefined, 10_000)
  view = handleKey({ ...view, pendingStop: undefined }, ctrlX, [row], [], undefined, 20_000)
  expect(view.pendingArchive).toBeUndefined()
  expect(view.pendingStop).toBe("first")
})

test("Ctrl+X archives an ended listener on the second press without stopping it", () => {
  const ended = { ...row, status: "stopped" as const }
  let view = handleKey(initialView, ctrlX, [ended], [], undefined, 10_000)
  expect(view.pendingStop).toBeUndefined()
  expect(view.notice).toContain("again to archive")
  view = handleKey(view, ctrlX, [ended], [], undefined, 10_500)
  expect(view.pendingArchive).toBe("first")
})

test("Ctrl+X asks before stopping a listener that holds a cart", () => {
  const view = handleKey(initialView, ctrlX, [{ ...row, status: "in_cart" }], [], undefined, 10_000)
  expect(view.stopTarget).toBe("first")
  expect(view.pendingStop).toBeUndefined()
})

test("a blocked listener shows as Blocked with the reason", () => {
  const blocked = { ...row, status: "blocked" as const, message: "Check failed (1): blocked: HTTP 403 at https://public-api.eventim.com/x" }
  const screen = plain(renderDashboard([blocked], initialView, { columns: 140, rows: 32, now: 2000 }))
  expect(screen).toContain("Blocked")
  expect(screen).toContain("HTTP 403")
  expect(screen).toContain("1 need attention")
})

test("dashboard stops and archives the selected listener on a double Ctrl+X", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "dashboard-archive-" })
    const registry = yield* makeListenerRegistry(root)
    yield* registry.start({ kind: "watch", url: row.url, profile: "default", everySeconds: 900 })
    const current = (yield* registry.read)[0]!
    const input = yield* Queue.make<Terminal.UserInput>()
    const screens: string[] = []
    const terminal = Terminal.make({ columns: Effect.succeed(100), rows: Effect.succeed(25), readInput: Effect.succeed(input), readLine: Effect.succeed(""), display: (text) => Effect.sync(() => { screens.push(plain(text)) }) })
    const waitScreen = (text: string) => Effect.sync(() => screens.at(-1)?.includes(text) ?? false).pipe(Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: Boolean }), Effect.timeout("4 seconds"))
    const fiber = yield* dashboard.pipe(
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provide(Stdio.layerTest({ stdinIsTerminal: Effect.succeed(true), stdoutIsTerminal: Effect.succeed(true) })),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ ...process.env, TICKET_LISTENERS_DIR: root, TICKET_BROWSER_HOME: path.join(root, "browsers") })),
      Effect.forkScoped,
    )
    yield* waitScreen("bjork")
    yield* Queue.offer(input, ctrlX)
    yield* waitScreen("Ctrl+X again to archive")
    expect(yield* fs.exists(path.join(root, `${current.runId}.stop`))).toBe(true)
    yield* Queue.offer(input, ctrlX)
    yield* waitScreen("Listener archived.")
    expect(screens.at(-1)).not.toContain("bjork")
    expect(yield* registry.read).toEqual([])
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)))
})

test("→ raises the browser of a live listener that has one and explains when there is none", () => {
  const withBrowser = { ...row, id: "cart", status: "in_cart" as const, browserPids: [4242] }
  expect(handleKey({ ...initialView, selectedId: "cart" }, key("right"), [withBrowser]).pendingReveal).toBe("cart")
  expect(handleKey(initialView, key("right"), [row]).notice).toBe("This listener has no open browser.")
  expect(handleKey({ ...initialView, selectedId: "cart" }, key("right"), [{ ...withBrowser, status: "stale" as const }]).pendingReveal).toBeUndefined()
})

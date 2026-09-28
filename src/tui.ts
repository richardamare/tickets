import { Clock, Data, Effect, Option, Queue, Stdio, Stream, Terminal } from "effect"
import { isLive, makeListenerRegistry, type ListenerRecord } from "./listeners.ts"
import { formQuestion, formSummary } from "./listener-form.ts"
import { makeListenerLauncher } from "./listener-launcher.ts"
import { handleKey, initialView, matchingCommands, promptText, visibleListeners, type View } from "./tui-prompt.ts"
import type { BrowserSelection } from "./browser-config.ts"
import { runCommand } from "./notifications.ts"

const clean = (value: string) => value
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const fit = (value: string, width: number) => {
  const text = clean(value)
  if (Bun.stringWidth(text) <= width) return text
  let result = ""
  let used = 0
  for (const { segment } of segments.segment(text)) {
    const size = Bun.stringWidth(segment)
    if (used + size > width - 1) break
    result += segment
    used += size
  }
  return result + "…"
}
const pad = (value: string, width: number) => {
  const text = fit(value, width)
  return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)))
}
const paint = (value: string, color: string) => `\x1b[${color}m${value}\x1b[0m`
const age = (ms: number) => ms < 60000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m` : `${Math.floor(ms / 3600000)}h`
const labels: Record<ListenerRecord["status"], string> = {
  starting: "Starting", checking: "Checking", waiting: "Listening", retrying: "Retrying", blocked: "Blocked", carting: "Adding to cart",
  in_cart: "In cart", completed: "Done", stopped: "Stopped", failed: "Failed", stale: "Offline",
}
const color = (row: ListenerRecord) => row.status === "in_cart" ? "92" : row.status === "blocked" ? "31" : ["failed", "retrying", "stale"].includes(row.status) ? "33" : isLive(row) ? "36" : "90"
const nameOf = (row: ListenerRecord) => {
  try {
    const url = new URL(row.url)
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname).replace(/-\d+$/, "").replaceAll("-", " ")
  } catch { return row.url }
}

export const renderDashboard = (
  rows: readonly ListenerRecord[], view: View,
  size: { readonly columns: number; readonly rows: number; readonly now: number; readonly error?: string; readonly accounts?: readonly string[] },
) => {
  const width = Math.max(1, size.columns - 1)
  const height = Math.max(1, size.rows - 1)
  const line = (text: string, style?: string) => style ? paint(fit(text, width), style) : fit(text, width)
  if (width < 45 || height < 12) return [line("Ticket Scraper"), line("Enlarge terminal to at least 46 × 13."), line("Ctrl+C closes UI; listeners keep running")].slice(0, height).join("\r\n")
  const waiting = rows.filter((row) => row.status === "waiting").length
  const working = rows.filter((row) => ["starting", "checking", "carting"].includes(row.status)).length
  const carts = rows.filter((row) => row.status === "in_cart").length
  const attention = rows.filter((row) => ["retrying", "blocked", "failed", "stale"].includes(row.status)).length
  const done = rows.filter((row) => ["completed", "stopped"].includes(row.status)).length
  const header = view.form || view.setup || height < 18 ? [line("  Ticket Scraper", "1;38;5;209"), ""] : [
    "",
    line("  ▟▙  Ticket Scraper", "1;38;5;209"),
    line("  ▝▘  Watch & restock · all terminal sessions", "90"),
    line(`      ${waiting} listening · ${working} working · ${carts} in cart · ${attention} need attention · ${done} ended`, "90"),
    "",
    line(`  Listeners${view.liveOnly ? " · active only" : ""}${view.query ? ` · filter: ${view.query}` : ""}`, "1"),
  ]
  const body: string[] = []
  const visible = visibleListeners(rows, view)
  const selected = Math.max(0, visible.findIndex((row) => row.id === view.selectedId))
  const panel: string[] = []
  if (view.setup) {
    panel.push(line(view.setup.step === "browser" ? "  Choose browser: 1 Chrome · 2 Edge" : "  Name the reusable source profile", "1;36"))
    panel.push(line(view.setup.step === "browser" ? "  Chrome is the default. Enter keeps your choice." : "  Sign in, then CLOSE the setup window to save.", "90"))
    if (view.setup.step === "profile") panel.push(line(`  Saved: ${(size.accounts ?? []).join(", ") || "none yet"}`, "90"))
  } else if (view.form) {
    const question = formQuestion(view.form)
    panel.push(line(`  ${question.label}`, "1;36"))
    if (view.form.step === "review") panel.push(...formSummary(view.form).map((text) => line(`  ${text}`, "90")))
    else if (view.form.step === "until") {
      panel.push(...["1 Keep watching · 2 Tickets on sale", "3 Sold out · 4 Sale has not opened", "5 Resale only"].map((choice) => line(`  ${choice}`, "90")))
    } else panel.push(line(`  ${question.hint}`, "90"))
    if (view.form.step === "profile") {
      const accounts = [view.form.profile, ...(size.accounts ?? []).filter((account) => account !== view.form!.profile)]
      const start = Math.max(0, view.accountIndex - 2)
      accounts.slice(start, start + 3).forEach((account, i) => {
        panel.push(line(`  ${start + i === view.accountIndex ? "❯" : " "} ${account || "Default profile"} (reusable)`, start + i === view.accountIndex ? "36" : "90"))
      })
    }
  } else if (view.stopTarget) {
    const row = rows.find((row) => row.id === view.stopTarget)
    const count = row?.runId ? rows.filter((other) => other.runId === row.runId && isLive(other)).length : 1
    panel.push(line(`  Stop ${row ? nameOf(row) : "this listener"}?`, "1;33"), line("  This closes its browser window. Cart holds may expire.", "33"))
    if (count > 1) panel.push(line(`  All ${count} events in this watch run will stop.`, "33"))
  } else {
    const menu = matchingCommands(view)
    const selectedCommand = view.menuIndex % Math.max(1, menu.length)
    const start = Math.max(0, selectedCommand - 3)
    menu.slice(start, start + 4).forEach((command, index) => panel.push(line(`  ${start + index === selectedCommand ? "❯" : " "} ${pad(command.name, 10)} ${command.description}`, start + index === selectedCommand ? "1;36" : "90")))
  }
  const alerts = [
    ...(size.error ? [line(`  Cannot refresh: ${size.error}`, "33")] : []),
    ...(view.formError ? [line(`  ${view.formError}`, "33")] : view.notice ? [line(`  ${view.notice}`, "90")] : []),
  ]
  const availablePanel = Math.max(1, height - header.length - 5)
  const visiblePanel = [...panel.slice(0, Math.max(0, availablePanel - alerts.length)), ...alerts].slice(0, availablePanel)
  const panelHeight = visiblePanel.length
  const bodyHeight = Math.max(1, height - header.length - 4 - panelHeight)
  if (view.help) {
    body.push(line("  Keyboard shortcuts · ? or Esc to close", "1"), "", ...[
      "  ↑/↓            Select listener, command or account", "  →              Bring the selected listener's browser to the front", "  Enter          Expand selected listener / submit prompt",
      "  Home/End       First / last listener", "  PgUp/PgDn      Move ten listeners",
      "  Ctrl+X         Stop selected listener", "  Ctrl+X Ctrl+X  Stop and archive selected listener",
      "  Tab            Complete slash command", "  Ctrl+B         Previous setup question", "  Esc            Cancel setup / clear filter",
      "  Ctrl+U         Clear the prompt", "  Ctrl+C         Close UI; listeners keep running", "",
      "  / lists every command: /watch /restock /stop /filter /active /quit",
    ].map((text) => line(text)))
  } else if (visible.length === 0) {
    body.push("", line(rows.length ? "  No listeners match this filter." : "  What would you like to listen for?", "90"), "",
      line("  /watch     Notify me when ticket availability changes"), line("  /restock   Reserve tickets when they become available"), "",
      line("  Type a command below. We will walk you through the settings.", "90"),
      line("  Your listeners keep running when you close this terminal.", "90"))
  } else {
    const detailSize = view.expanded ? Math.min(9, Math.max(0, bodyHeight - 2)) : 0
    const capacity = Math.max(1, bodyHeight - detailSize)
    const start = Math.max(0, selected - capacity + 1)
    for (let index = start; index < Math.min(visible.length, start + capacity); index++) {
      const row = visible[index]!
      const titleWidth = Math.max(12, Math.min(40, Math.floor(width * 0.33)))
      const title = pad(nameOf(row), titleWidth)
      const status = pad(labels[row.status], 14)
      const timing = row.nextCheckAt === undefined ? age(size.now - row.startedAt) : `next ${age(row.nextCheckAt - size.now)}`
      const prefix = ` ${index === selected ? "❯" : "·"} ${title} ${status} · `
      const messageWidth = width - Bun.stringWidth(prefix) - timing.length - 2
      const text = messageWidth >= 8
        ? `${prefix}${pad(row.message, messageWidth)}  ${timing}`
        : ` ${index === selected ? "❯" : "·"} ${labels[row.status]} · ${nameOf(row)}`
      body.push(paint(fit(text, width), index === selected ? `1;${color(row)}` : color(row)))
      if (index === selected && view.expanded) {
        const details = [
          `     ${row.url}`,
          `     ${row.kind} · profile ${row.profile} · every ${row.everySeconds}s`,
          `     Last check: ${row.lastCheckAt === undefined ? "not yet" : new Date(row.lastCheckAt).toLocaleTimeString()} · ${row.nextCheckAt === undefined ? "no check scheduled" : `next in ${age(row.nextCheckAt - size.now)}`}`,
          `     ${row.message}`,
          ...row.history.slice(-4).map((entry) => `     ${new Date(entry.at).toLocaleTimeString()}  ${entry.message}`),
          "",
        ]
        body.push(...details.slice(0, detailSize).map((text) => line(text, "90")))
      }
    }
  }
  const footer = [
    line("─".repeat(width), "90"),
    line(`❯ ${promptText(view)}`, view.input || view.form || view.setup || view.filtering ? "36" : "90"),
    line("─".repeat(width), "90"),
    line(view.form ? "  Enter continue · Ctrl+B back · Esc cancel" : view.filtering ? "  type to filter · Enter apply · Esc clear" : "  / for commands · ? for shortcuts", "90"),
  ]
  return [...header, ...body.slice(0, bodyHeight), ...Array(Math.max(0, bodyHeight - body.length)).fill(""), ...visiblePanel, ...footer]
    .map((text) => `${text}\x1b[K`).join("\r\n")
}

class DashboardError extends Data.TaggedError("DashboardError")<{ readonly message: string }> {}

export const dashboard = Effect.scoped(Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
    return yield* new DashboardError({ message: "The dashboard needs an interactive terminal. Use bun run start --help for commands." })
  }
  const terminal = yield* Terminal.Terminal
  const registry = yield* makeListenerRegistry()
  const launcher = yield* makeListenerLauncher
  let selection: BrowserSelection = { browser: "chrome", profile: "default" }
  let accounts: readonly string[] = []
  const updates = yield* Queue.make<View>()
  let view = initialView
  let rows: ListenerRecord[] = []
  let error: string | undefined
  const draw = Effect.gen(function* () {
    const result = yield* Effect.result(registry.read)
    if (result._tag === "Success") { rows = result.success; error = undefined }
    else error = result.failure.message
    const config = yield* Effect.result(Effect.gen(function* () {
      const saved = yield* launcher.browserProfiles.readSettings
      const profiles = yield* launcher.browserProfiles.listProfiles(view.setup?.browser ?? view.form?.browser ?? saved.browser)
      return { saved, profiles }
    }))
    if (config._tag === "Success") { selection = config.success.saved; accounts = config.success.profiles }
    else error = [error, config.failure.message].filter(Boolean).join("; ")
    if (view.setupInProgress) {
      const setup = yield* Effect.result(launcher.browserProfiles.status(view.setupInProgress))
      if (setup._tag === "Failure") error = [error, setup.failure.message].filter(Boolean).join("; ")
      else if (setup.success.setupError) error = [error, setup.success.setupError].filter(Boolean).join("; ")
      else if (setup.success.ready) view = { ...view, setupInProgress: undefined, notice: "Source profile saved. Start a listener with /watch or /restock." }
    }
    if (view.stoppingRunId) {
      const outcome = yield* Effect.result(registry.readRunOutcome(view.stoppingRunId))
      if (outcome._tag === "Failure") error = [error, outcome.failure.message].filter(Boolean).join("; ")
      else if (Option.isSome(outcome.success)) view = { ...view, stoppingRunId: undefined, notice: outcome.success.value.status === "stopped" ? "Listener stopped." : `Listener ended: ${outcome.success.value.status}.` }
    }
    const visible = visibleListeners(rows, view)
    if (!visible.some((row) => row.id === view.selectedId)) view = { ...view, selectedId: visible[0]?.id }
    yield* terminal.display("\x1b[H" + renderDashboard(rows, view, {
      columns: yield* terminal.columns, rows: yield* terminal.rows, now: yield* Clock.currentTimeMillis, error, accounts,
    }) + "\x1b[J")
  })
  yield* Effect.acquireRelease(
    terminal.display("\x1b[?1049h\x1b[?25l"),
    () => terminal.display("\x1b[0m\x1b[?25h\x1b[?1049l").pipe(Effect.ignore),
  )
  const input = yield* terminal.readInput
  yield* draw
  yield* Stream.fromQueue(input).pipe(
    Stream.map((event) => ({ type: "key" as const, event })),
    Stream.merge(Stream.tick("1 second").pipe(Stream.map(() => ({ type: "tick" as const }))), { haltStrategy: "left" }),
    Stream.merge(Stream.fromQueue(updates).pipe(Stream.map((view) => ({ type: "update" as const, view }))), { haltStrategy: "left" }),
    Stream.mapEffect((event) => Effect.map(Clock.currentTimeMillis, (now) => ({ event, now }))),
    Stream.takeWhile(({ event, now }) => {
      if (event.type === "key") view = handleKey(view, event.event, rows, accounts, selection, now)
      if (event.type === "update") view = event.view
      return !view.quit
    }),
    Stream.runForEach(() => Effect.gen(function* () {
      if (view.pendingSetup && !view.launching) {
        const selected = view.pendingSetup
        view = { ...view, launching: true, pendingSetup: undefined }
        const pendingView = view
        yield* launcher.setup(selected).pipe(
          Effect.match({
            onFailure: (error): View => ({ ...pendingView, launching: false, formError: error.message }),
            onSuccess: (): View => ({ ...pendingView, launching: false, setup: undefined, setupInProgress: selected, formError: undefined, notice: `Sign in to ${selected.browser}, then CLOSE the setup window to save '${selected.profile}'. Setup survives closing this UI.` }),
          }), Effect.flatMap((next) => Queue.offer(updates, next)), Effect.forkScoped,
        )
      }
      if (view.pendingRequest && !view.launching) {
        const request = view.pendingRequest
        view = { ...view, launching: true, pendingRequest: undefined }
        const pendingView = view
        yield* launcher.launch(request).pipe(
          Effect.match({
            onFailure: (error): View => ({ ...pendingView, launching: false, formError: error.message }),
            onSuccess: (row): View => ({ ...pendingView, launching: false, form: undefined, formError: undefined, selectedId: row.id, query: "", notice: "Listener started in the background. You can close this UI; use /stop to end it." }),
          }),
          Effect.flatMap((next) => Queue.offer(updates, next)), Effect.forkScoped,
        )
      }
      if (view.pendingStop) {
        const row = rows.find((row) => row.id === view.pendingStop)
        const result = row ? yield* Effect.result(registry.requestStop(row)) : undefined
        view = { ...view, pendingStop: undefined, stoppingRunId: result?._tag === "Success" ? row?.runId : undefined, notice: !row ? "The listener is no longer listed." : result?._tag === "Failure" ? result.failure.message : `Stop requested. Waiting for the listener to close its browser…${view.archiveArmed ? " Ctrl+X again to archive." : ""}` }
      }
      if (view.pendingReveal) {
        const row = rows.find((row) => row.id === view.pendingReveal)
        const pid = row?.browserPid
        const result = pid === undefined ? undefined : yield* Effect.result(runCommand("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]))
        view = { ...view, pendingReveal: undefined, notice: result === undefined ? "This listener has no open browser." : result._tag === "Failure" ? `Cannot open the browser: ${result.failure.message}` : undefined }
      }
      if (view.pendingArchive) {
        const row = rows.find((row) => row.id === view.pendingArchive)
        if (row && (isLive(row) || row.status === "stale") && view.stoppingRunId !== row.runId) yield* Effect.ignore(registry.requestStop(row))
        const result = row ? yield* Effect.result(registry.archive(row)) : undefined
        view = { ...view, pendingArchive: undefined, notice: !row ? "The listener is no longer listed." : result?._tag === "Failure" ? `Cannot archive: ${result.failure.message}` : "Listener archived." }
      }
      yield* draw
    })),
  )
}))

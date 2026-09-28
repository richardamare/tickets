import { Option, Schema, type Terminal } from "effect"
import { formQuestion, previousStep, startForm, submitForm, type ListenerForm } from "./listener-form.ts"
import type { ListenerRequest } from "./listener-request.ts"
import { ProfileName } from "./listener-request.ts"
import type { BrowserSelection } from "./browser-config.ts"
import { isLive, type ListenerRecord } from "./listeners.ts"

export const commands = [
  { name: "/setup", description: "Choose Chrome or Edge and prepare a reusable source profile" },
  { name: "/watch", description: "Watch an event and notify me when tickets change" },
  { name: "/restock", description: "Reserve tickets when they appear (Fnac Spectacles)" },
  { name: "/stop", description: "Stop the selected listener and close its browser window" },
  { name: "/filter", description: "Find a listener by event or account" },
  { name: "/active", description: "Show active listeners / all history" },
  { name: "/help", description: "Show keyboard shortcuts" },
  { name: "/quit", description: "Close this UI; listeners keep running" },
] as const
export interface View {
  readonly selectedId?: string
  readonly expanded: boolean
  readonly help: boolean
  readonly filtering: boolean
  readonly query: string
  readonly liveOnly: boolean
  readonly quit: boolean
  readonly input: string
  readonly menuIndex: number
  readonly accountIndex: number
  readonly setup?: { readonly step: "browser" | "profile"; readonly browser: BrowserSelection["browser"]; readonly profile: string }
  readonly pendingSetup?: BrowserSelection
  readonly setupInProgress?: BrowserSelection
  readonly form?: ListenerForm
  readonly formError?: string
  readonly pendingRequest?: ListenerRequest
  readonly launching?: boolean
  readonly stopTarget?: string
  readonly pendingStop?: string
  readonly stoppingRunId?: string
  readonly archiveArmed?: { readonly id: string; readonly at: number }
  readonly pendingArchive?: string
  readonly pendingReveal?: string
  readonly notice?: string
}
export const initialView: View = { expanded: false, help: false, filtering: false, query: "", liveOnly: false, quit: false, input: "", menuIndex: 0, accountIndex: 0 }
export const visibleListeners = (rows: readonly ListenerRecord[], view: View) => rows.filter((row) =>
  (!view.liveOnly || isLive(row)) && `${row.url} ${row.profile} ${row.kind} ${row.status} ${row.message}`.toLowerCase().includes(view.query.toLowerCase()),
)
export const matchingCommands = (view: View) => view.input.startsWith("/") && !view.input.includes(" ") && !view.form && !view.setup && !view.filtering
  ? commands.filter((command) => command.name.startsWith(view.input.toLowerCase())) : []
const editable = (event: Terminal.UserInput) => {
  const char = Option.getOrElse(event.input, () => "")
  return !event.key.ctrl && !event.key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(char) ? char : ""
}

export const archiveWindowMs = 1500

// Ctrl+X stops the selected listener, and a second Ctrl+X on it within archiveWindowMs archives it, hiding it from
// every view. A listener holding a cart asks first, since stopping it closes the browser that holds the tickets.
const cut = (view: View, rows: readonly ListenerRecord[], now: number): View => {
  const visible = visibleListeners(rows, view)
  const row = visible.find((row) => row.id === view.selectedId) ?? visible[0]
  if (!row) return { ...view, notice: "Select a listener with ↑/↓ first." }
  if (view.archiveArmed?.id === row.id && now - view.archiveArmed.at <= archiveWindowMs)
    return { ...view, archiveArmed: undefined, pendingArchive: row.id, notice: "Archiving listener…" }
  if (row.status === "in_cart") return { ...view, archiveArmed: undefined, stopTarget: row.id }
  const armed = { ...view, archiveArmed: { id: row.id, at: now } }
  return isLive(row) || (row.status === "stale" && row.runId)
    ? { ...armed, pendingStop: row.id, notice: "Stopping listener… Ctrl+X again to archive it." }
    : { ...armed, notice: "Press Ctrl+X again to archive this listener." }
}

export const handleKey = (view: View, event: Terminal.UserInput, rows: readonly ListenerRecord[], accounts: readonly string[] = [], selection: BrowserSelection = { browser: "chrome", profile: "default" }, now = 0): View => {
  const { key } = event
  const char = editable(event)
  if (key.ctrl && (key.name === "c" || key.name === "d")) return { ...view, quit: true }
  if (view.launching) return view
  if (key.name === "escape") return { ...view, filtering: false, query: "", help: false, expanded: false, input: "", form: undefined, setup: undefined, formError: undefined, stopTarget: undefined, notice: undefined }
  if (view.stopTarget) return key.name === "return" ? { ...view, pendingStop: view.stopTarget, stopTarget: undefined, notice: "Stopping listener…" } : view
  if (view.filtering) {
    if (key.name === "return") return { ...view, filtering: false }
    if (key.name === "backspace") return { ...view, query: [...view.query].slice(0, -1).join("") }
    return { ...view, query: (view.query + char).slice(0, 200) }
  }
  if (view.setup) {
    if (key.name === "backspace") return { ...view, input: [...view.input].slice(0, -1).join(""), formError: undefined }
    if (key.name === "return") {
      if (view.setup.step === "browser") {
        const value = view.input.trim().toLowerCase() || view.setup.browser
        const browser = value === "1" || value === "chrome" ? "chrome" : value === "2" || value === "edge" ? "edge" : undefined
        return browser ? { ...view, input: "", setup: { ...view.setup, browser, step: "profile" }, formError: undefined } : { ...view, formError: "Choose 1 Chrome or 2 Edge." }
      }
      const profile = view.input.trim() || view.setup.profile
      if (!profile || !Schema.is(ProfileName)(profile)) return { ...view, formError: "Use letters, numbers, dots, underscores or hyphens for the account name." }
      return { ...view, input: "", pendingSetup: { browser: view.setup.browser, profile }, formError: undefined }
    }
    return { ...view, input: (view.input + char).slice(0, 100), formError: undefined }
  }
  if (view.form) {
    if (key.ctrl && key.name === "b") {
      const form = previousStep(view.form)
      return { ...view, form, input: form.step === "url" ? form.url : form.step === "profile" ? form.profile : "", formError: undefined }
    }
    if (view.form.step === "profile" && (key.name === "up" || key.name === "down")) {
      return { ...view, input: "", accountIndex: Math.max(0, Math.min(accounts.filter((account) => account !== view.form!.profile).length, view.accountIndex + (key.name === "down" ? 1 : -1))) }
    }
    if (key.name === "return") {
      const value = view.form.step === "profile" && !view.input ? [view.form.profile, ...accounts.filter((account) => account !== view.form!.profile)][view.accountIndex] ?? view.form.profile : view.input
      const result = submitForm(view.form, value)
      return result.error
        ? { ...view, formError: result.error }
        : { ...view, form: result.form, input: "", formError: undefined, pendingRequest: result.request }
    }
    if (key.name === "backspace") return { ...view, input: [...view.input].slice(0, -1).join(""), formError: undefined }
    if (view.form.step === "review") return view
    return { ...view, input: (view.input + char).slice(0, 2048), formError: undefined }
  }
  const menu = matchingCommands(view)
  if (menu.length && (key.name === "up" || key.name === "down")) {
    return { ...view, menuIndex: (view.menuIndex + (key.name === "down" ? 1 : menu.length - 1)) % menu.length }
  }
  if (menu.length && key.name === "tab") return { ...view, input: menu[view.menuIndex % menu.length]!.name, menuIndex: 0 }
  if (key.name === "return" && view.input.trim()) {
    const [typed, ...args] = view.input.trim().split(/\s+/)
    const command = commands.some((command) => command.name === typed) ? typed : menu[view.menuIndex % menu.length]?.name
    const reset = { ...view, input: "", menuIndex: 0, notice: undefined, help: false }
    if (command === "/watch" || command === "/restock") {
      const form = startForm(command === "/watch" ? "watch" : "restock", selection)
      const result = args.length ? submitForm(form, args.join(" ")) : { form }
      return { ...reset, form: result.form, formError: result.error, accountIndex: 0, input: result.error ? args.join(" ") : "" }
    }
    if (args.length) return { ...view, notice: "Press Enter on a command first; the guided setup will ask for its settings." }
    if (command === "/setup") return { ...reset, setup: { ...selection, step: "browser" }, formError: undefined }
    if (command === "/filter") return { ...reset, filtering: true }
    if (command === "/active") return { ...reset, liveOnly: !view.liveOnly }
    if (command === "/help") return { ...reset, help: true }
    if (command === "/quit") return { ...reset, quit: true }
    if (command === "/stop") {
      const visible = visibleListeners(rows, view)
      const selected = visible.find((row) => row.id === view.selectedId) ?? visible[0]
      return selected && (isLive(selected) || (selected.status === "stale" && selected.runId)) ? { ...reset, stopTarget: selected.id } : { ...reset, notice: "Select an active listener with ↑/↓ first." }
    }
    return { ...view, notice: "Type /watch or /restock to start a listener. Type / to see all commands." }
  }
  if (key.name === "backspace") return { ...view, input: [...view.input].slice(0, -1).join(""), menuIndex: 0, notice: undefined }
  if (key.ctrl && key.name === "u") return { ...view, input: "", notice: undefined }
  if (view.input === "") {
    if (char === "?") return { ...view, help: !view.help }
    if (key.ctrl && key.name === "x") return cut(view, rows, now)
    if (key.name === "right") {
      const visible = visibleListeners(rows, view)
      const row = visible.find((row) => row.id === view.selectedId) ?? visible[0]
      // A stale row's process may be gone and its pid reused, so only a live listener's browser is raised.
      return row && isLive(row) && (row.browserPids?.length ?? 0) > 0
        ? { ...view, pendingReveal: row.id, notice: undefined }
        : { ...view, notice: "This listener has no open browser." }
    }
    if (key.name === "return") return { ...view, expanded: !view.expanded }
    const visible = visibleListeners(rows, view)
    const current = Math.max(0, visible.findIndex((row) => row.id === view.selectedId))
    let next = current
    if (key.name === "down") next++
    if (key.name === "up") next--
    if (key.name === "home") next = 0
    if (key.name === "end") next = visible.length - 1
    if (key.name === "pagedown") next += 10
    if (key.name === "pageup") next -= 10
    if (next !== current) return { ...view, selectedId: visible[Math.max(0, Math.min(visible.length - 1, next))]?.id }
  }
  return { ...view, input: (view.input + char).slice(0, 2048), menuIndex: 0, notice: undefined }
}

export const promptText = (view: View) => {
  if (view.launching) return "Starting in the background…"
  if (view.stopTarget) return "Press Enter to stop, or Esc to keep running"
  if (view.filtering) return `Filter: ${view.query}█`
  if (view.setup) return view.input ? `${view.input}█` : `[${view.setup.step === "browser" ? view.setup.browser : view.setup.profile}]`
  if (view.form) {
    const question = formQuestion(view.form)
    return view.input ? `${view.input}█` : question.defaultValue ? `[${question.defaultValue}]` : "█"
  }
  return view.input ? `${view.input}█` : "Start a listener with /watch or /restock · / for commands"
}

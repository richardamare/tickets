import { Data, Effect, Option, Redacted, Schema } from "effect"
import type { FunctionTool, Response, ResponseFunctionToolCall, ResponseInputItem, ResponseReasoningItem } from "openai/resources/responses/responses"
import { BrowserError, Locator, Page } from "./browser.ts"
import { Foundry } from "./foundry.ts"
import { describeSeats, type Seat, SeatProviders, type SeatsError } from "./seats.ts"
import { type SecretError, Secrets } from "./secrets.ts"
import { AgentState, type StateError } from "./state.ts"

const MAX_TOOL_OUTPUT = 20_000

const INSTRUCTIONS = `
You complete the user's task by operating a real web browser through your tools. Everything you report is evidence: text you read on a page during this run.

Work in three steps.

1. Orient. Open the starting page and read it before acting on it. When a cookie or consent banner covers the page, accept it and read again. Build every selector from something you have read: visible text (text=Sign in) or markup the page has shown you.

2. Gather. Visit every page the task needs: listings, detail pages, further pages of results. Record each finding the moment you read it with state_write, one entry per item (an event, a ticket tier, an order) keyed by what identifies it, and extend it with state_update as later pages add fields. Record a field the page omits as "not shown", and a page that fails as "could not load" with its error. This step is done when every item the task asks for has an entry and every requested field in it holds a value, "not shown" or "could not load".

3. Answer. Call state_read and write the answer from the state alone, with the URL each item came from.

Every click is a real mouse click: the cursor travels to the element and presses it. When the target is covered, the click is not made and the error names what covers it. A cursor passing over a menu or map region can open a dropdown or tooltip on the way, and marketing popups appear on their own. Clear it before trying again: click an empty spot such as a page heading or the side panel, then click the target once more, reaching it from a different direction if the same thing opens again. After each click, read the part of the page it should change (a selected count, a panel, the URL) and confirm it did what you meant; when it changed something else instead, such as a filter or a tab, set that back before you continue.

On a site with a seat provider, read seats with list_free_seats and reserve them with add_seats_to_cart rather than clicking through the seat map yourself. A cart holds seats for a few minutes and costs nothing. Never enter payment details or confirm a purchase.

When a page asks you to sign in, call list_secrets and enter each credential with fill_secret by name; the values stay hidden from you, so every credential goes through fill_secret.
`.trim()

export type ToolEvent = {
  readonly step: number
  readonly tool: string
  readonly args: string
  readonly ok: boolean
  readonly output: string
}

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly reason: "step-limit" | "empty-answer" | "truncated" | "content-filter" | "unexpected-status"
  readonly detail: string
  readonly trace: ReadonlyArray<ToolEvent>
}> {
  override get message() {
    return `Agent stopped without an answer (${this.reason}): ${this.detail}`
  }
}

type Tool = {
  readonly definition: FunctionTool
  readonly run: (rawArgs: string) => Effect.Effect<string, string, Page | AgentState | Secrets | SeatProviders>
}

const tool = <S extends Schema.Top>(
  name: string,
  description: string,
  input: S,
  run: (
    args: S["Type"],
  ) => Effect.Effect<
    string,
    BrowserError | StateError | SecretError | SeatsError | Schema.SchemaError,
    Page | AgentState | Secrets | SeatProviders | S["DecodingServices"]
  >,
) => ({
  definition: {
    type: "function" as const,
    name,
    description,
    strict: false,
    parameters: Schema.toJsonSchemaDocument(input).schema as Record<string, unknown>,
  },
  run: (rawArgs: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(input))(rawArgs).pipe(
      Effect.mapError((error) => `Invalid arguments for ${name}: ${error.message}`),
      Effect.flatMap((args) => run(args).pipe(Effect.mapError((error) => error.message))),
    ),
})

// Truncation is stated in the output, so the model knows it saw part of the page rather than all of it.
const cap = (text: string) =>
  text.length <= MAX_TOOL_OUTPUT
    ? text
    : `${text.slice(0, MAX_TOOL_OUTPUT)}\n[truncated: showing ${MAX_TOOL_OUTPUT} of ${text.length} characters; use a narrower selector]`

const Selector = Schema.String.annotate({ description: "Playwright selector, e.g. 'css=.event-card' or 'text=Buy tickets'" })

const pageUrl = Page.use((page) => page.url)

// A selector that matches nothing says so, because an empty list reads as "the page has none of these".
const noMatch = (selector: string) =>
  pageUrl.pipe(
    Effect.map(
      (url) =>
        `No elements match ${selector} on ${url}. This says nothing about the page content; read_text the body to see its actual markup and text.`,
    ),
  )

const NoArgs = Schema.Record(Schema.String, Schema.Never)
const Texts = Schema.fromJsonString(Schema.Array(Schema.String))
const Links = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ text: Schema.String, href: Schema.String })),
)

export const browserTools: ReadonlyArray<Tool> = [
  tool("navigate", "Open a URL in the browser.", Schema.Struct({ url: Schema.String }), ({ url }) =>
    Page.use((page) =>
      Effect.gen(function* () {
        yield* page.goto(url)
        return `Loaded ${yield* page.url} (title: ${yield* page.title})`
      }),
    ),
  ),
  tool("current_url", "Return the URL of the current page.", NoArgs, () => pageUrl),
  tool(
    "read_text",
    "Return the visible text of the first element matching the selector (defaults to the whole page body).",
    Schema.Struct({ selector: Schema.optionalKey(Selector) }),
    ({ selector }) => Locator.use((locator) => locator.first().innerText).pipe(Locator.at(selector ?? "body"), Effect.map(cap)),
  ),
  tool(
    "read_all",
    "Return the visible text of every element matching the selector as a JSON array, e.g. one entry per event row.",
    Schema.Struct({ selector: Selector }),
    ({ selector }) =>
      Locator.use((locator) => locator.allInnerTexts).pipe(
        Locator.at(selector),
        Effect.flatMap((texts) =>
          texts.length === 0 ? noMatch(selector) : Schema.encodeEffect(Texts)(texts).pipe(Effect.map(cap)),
        ),
      ),
  ),
  tool(
    "list_links",
    "Return the text and absolute href of every link inside the selector (defaults to the whole page) as JSON.",
    Schema.Struct({ selector: Schema.optionalKey(Selector) }),
    ({ selector }) =>
      Effect.gen(function* () {
        const base = yield* pageUrl
        const scope = selector ?? "body"
        const links = yield* Locator.use((locator) => locator.locator("a[href]").all).pipe(Locator.at(scope))
        if (links.length === 0) return yield* noMatch(`${scope} >> a[href]`)
        const rows = yield* Effect.forEach(
          links,
          (link) =>
            Effect.all({ text: link.innerText, href: link.getAttribute("href") }).pipe(
              Effect.map(({ text, href }) => ({ text: text.trim(), href })),
            ),
          { concurrency: 8 },
        )
        const resolved = rows.flatMap(({ text, href }) =>
          Option.match(href, {
            onNone: () => [],
            onSome: (raw) => [{ text, href: Option.getOrElse(Option.liftThrowable(() => new URL(raw, base).href)(), () => raw) }],
          }),
        )
        return cap(yield* Schema.encodeEffect(Links)(resolved))
      }),
  ),
  tool(
    "click",
    "Move the mouse to the first element matching the selector and click it. Fails without clicking when something covers the element, naming what covers it.",
    Schema.Struct({ selector: Selector }),
    ({ selector }) =>
    Effect.gen(function* () {
      yield* Locator.use((locator) => locator.first().mouseClick).pipe(Locator.at(selector))
      yield* Page.use((page) => page.waitForLoad)
      return `Clicked ${selector}; now at ${yield* pageUrl} (title: ${yield* Page.use((page) => page.title)})`
    }),
  ),
  tool(
    "fill",
    "Type a value into the first input matching the selector.",
    Schema.Struct({ selector: Selector, value: Schema.String }),
    ({ selector, value }) =>
      Locator.use((locator) => locator.first().fill(value)).pipe(Locator.at(selector), Effect.as(`Filled ${selector}`)),
  ),
]

const StateKey = Schema.String.annotate({ description: "Entry name, e.g. 'event:radiohead-2026-11-02'" })
const StateValue = Schema.fromJsonString(Schema.Json)
const StateSnapshot = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

export const stateTools: ReadonlyArray<Tool> = [
  tool(
    "state_write",
    "Create a new entry in the shared state. Fails if the key already exists.",
    Schema.Struct({ key: StateKey, value: Schema.Json }),
    ({ key, value }) => AgentState.use((state) => state.write(key, value)).pipe(Effect.as(`Wrote ${key}`)),
  ),
  tool(
    "state_update",
    "Replace the value of an existing entry in the shared state. Fails if the key does not exist.",
    Schema.Struct({ key: StateKey, value: Schema.Json }),
    ({ key, value }) => AgentState.use((state) => state.update(key, value)).pipe(Effect.as(`Updated ${key}`)),
  ),
  tool(
    "state_read",
    "Return one entry of the shared state, or every entry as a JSON object when no key is given.",
    Schema.Struct({ key: Schema.optionalKey(StateKey) }),
    ({ key }) =>
      AgentState.use((state) =>
        key === undefined
          ? state.snapshot.pipe(Effect.flatMap(Schema.encodeEffect(StateSnapshot)))
          : state.read(key).pipe(Effect.flatMap(Schema.encodeEffect(StateValue))),
      ).pipe(Effect.map(cap)),
  ),
]

const SecretList = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ name: Schema.String, origins: Schema.Union([Schema.Array(Schema.String), Schema.Literal("any")]) }),
  ),
)

// The secret value goes from the environment straight into the field; neither the model, the tool output nor the trace sees it.
export const secretTools: ReadonlyArray<Tool> = [
  tool(
    "list_secrets",
    "Return the names of the secrets you can enter with fill_secret and the origins each one is limited to.",
    NoArgs,
    () => Secrets.use((secrets) => Schema.encodeEffect(SecretList)(secrets.list)),
  ),
  tool(
    "fill_secret",
    "Type a named secret (password, email, card number...) into the first input matching the selector.",
    Schema.Struct({ selector: Selector, name: Schema.String.annotate({ description: "Secret name from list_secrets" }) }),
    ({ selector, name }) =>
      Effect.gen(function* () {
        const url = yield* pageUrl
        const origin = Option.getOrElse(Option.liftThrowable(() => new URL(url).origin)(), () => url)
        const value = yield* Secrets.use((secrets) => secrets.valueFor(name, origin))
        const secret = Redacted.value(value)
        // Playwright's error call log quotes the typed text, so only the first line survives, with the value scrubbed.
        yield* Locator.use((locator) => locator.first().fill(secret)).pipe(
          Locator.at(selector),
          Effect.mapError(
            (error) =>
              new BrowserError({
                operation: `fill ${selector} with secret ${name}`,
                cause: String(error.cause instanceof Error ? error.cause.message : error.cause)
                  .split("\n")[0]!
                  .replaceAll(secret, "[secret]"),
              }),
          ),
        )
        return `Filled ${selector} with secret ${name}`
      }),
  ),
]

const SeatsFilter = Schema.Struct({
  url: Schema.String.annotate({ description: "Event page URL" }),
  category: Schema.optionalKey(Schema.String.annotate({ description: "Only this price category, e.g. 'Price 2'" })),
  block: Schema.optionalKey(Schema.String.annotate({ description: "Only this block, e.g. 'Orchestre'" })),
})

export const seatTools: ReadonlyArray<Tool> = [
  tool(
    "list_free_seats",
    "Read the event's seating chart through the site's seat provider. Returns free seats per category and row; with category or block it also lists each matching free seat as 'id block row position category' for add_seats_to_cart. position is the order within the row, so consecutive positions sit next to each other. The site refuses a selection that leaves a single free seat alone between taken seats or the row's end; a seat marked 'leaves a single gap' would do that when booked on its own, so book it together with that neighbour or choose another.",
    SeatsFilter,
    ({ url, category, block }) =>
      Effect.gen(function* () {
        const { provider, url: parsed } = yield* SeatProviders.use((providers) => providers.providerFor(url))
        const seats = yield* provider.read(parsed)
        const summary = describeSeats(seats)
        if (category === undefined && block === undefined) return cap(summary)
        const matching = seats.filter(
          (seat) => seat.available && (category === undefined || seat.category === category) && (block === undefined || seat.block === block),
        )
        const rows = new Map<string, Map<number, boolean>>()
        for (const seat of seats) {
          const row = rows.get(`${seat.block} ${seat.row}`) ?? new Map<number, boolean>()
          row.set(seat.position, seat.available)
          rows.set(`${seat.block} ${seat.row}`, row)
        }
        const leavesGap = (seat: Seat) => {
          const row = rows.get(`${seat.block} ${seat.row}`)!
          const free = (position: number) => row.get(position) === true
          return (free(seat.position - 1) && !free(seat.position - 2)) || (free(seat.position + 1) && !free(seat.position + 2))
        }
        const lines = matching.map(
          (seat) => `${seat.id} ${seat.block} ${seat.row} ${seat.position} ${seat.category}${leavesGap(seat) ? " (leaves a single gap)" : ""}`,
        )
        return cap(`${summary}\n\nMatching free seats (${matching.length}):\n${lines.join("\n")}`)
      }),
  ),
  tool(
    "add_seats_to_cart",
    "Select the given seats on the event's seating chart with the mouse and put them in the cart, stopping before payment. Returns the cart page URL and what the cart holds.",
    Schema.Struct({
      url: Schema.String.annotate({ description: "Event page URL" }),
      seatIds: Schema.Array(Schema.String).annotate({ description: "Seat ids from list_free_seats" }),
    }),
    ({ url, seatIds }) =>
      Effect.gen(function* () {
        const { provider, url: parsed } = yield* SeatProviders.use((providers) => providers.providerFor(url))
        const cart = yield* provider.addToCart(parsed, seatIds)
        return cap(`Cart at ${cart.url}:\n${cart.contents}`)
      }),
  ),
]

const tools = [...browserTools, ...seatTools, ...stateTools, ...secretTools]

const instructions = `${INSTRUCTIONS}\n\nYour tools:\n${tools
  .map(({ definition }) => `- ${definition.name}: ${definition.description}`)
  .join("\n")}`

const runToolCall = (call: ResponseFunctionToolCall) => {
  const found = tools.find((t) => t.definition.name === call.name)
  return found ? found.run(call.arguments) : Effect.fail(`Unknown tool ${call.name}`)
}

const preview = (text: string) => {
  const flat = text.replaceAll("\n", " ")
  return flat.length > 300 ? `${flat.slice(0, 300)}… (${text.length} characters)` : flat
}

const logResponse = (response: Response) =>
  Effect.gen(function* () {
    for (const item of response.output) {
      if (item.type === "reasoning")
        for (const part of (item as ResponseReasoningItem).summary) yield* Effect.logInfo(`Agent thinks: ${part.text}`)
      if (item.type === "message")
        for (const part of item.content) if (part.type === "output_text" && part.text.trim()) yield* Effect.logInfo(`Agent says: ${part.text}`)
    }
    const usage = response.usage
    if (usage)
      yield* Effect.logDebug(
        `Model used ${usage.input_tokens} input (${usage.input_tokens_details.cached_tokens} cached), ${usage.output_tokens} output (${usage.output_tokens_details.reasoning_tokens} reasoning) tokens`,
      )
  })

export const runAgent = (task: string, options: { readonly maxSteps: number }) =>
  Effect.gen(function* () {
    const foundry = yield* Foundry
    const trace: Array<ToolEvent> = []
    const stop = (reason: AgentError["reason"], detail: string) =>
      Effect.logWarning(`Agent stopped (${reason}): ${detail}`).pipe(Effect.as(new AgentError({ reason, detail, trace })), Effect.flatMap(Effect.fail))

    let input: string | Array<ResponseInputItem> = task
    let previousResponseId: string | undefined
    yield* Effect.logInfo(`Agent task: ${task}`)

    for (let step = 1; step <= options.maxSteps; step++) {
      const response = yield* foundry
        .respond({
          instructions,
          input,
          tools: tools.map((t) => t.definition),
          parallel_tool_calls: false,
          // Asks for a summary of the model's reasoning so the log shows why it acts, not only what it does.
          reasoning: { summary: "auto" },
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        })
        .pipe(Effect.withLogSpan("model"), Effect.annotateLogs("step", step))
      yield* logResponse(response).pipe(Effect.annotateLogs("step", step))

      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason
        if (reason === "max_output_tokens") return yield* stop("truncated", "the model hit its output token limit")
        if (reason === "content_filter") return yield* stop("content-filter", "Azure content filtering blocked the response")
        return yield* stop("unexpected-status", `response incomplete: ${reason ?? "no reason given"}`)
      }
      if (response.status !== "completed") {
        return yield* stop("unexpected-status", `response ${response.status}: ${response.error?.message ?? "no error given"}`)
      }

      const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call")
      if (calls.length === 0) {
        const answer = response.output_text.trim()
        if (!answer) return yield* stop("empty-answer", "the model finished without text or tool calls")
        yield* Effect.logInfo(`Agent answered after ${step} model calls`)
        return { answer, trace, steps: step, state: yield* AgentState.use((state) => state.snapshot) }
      }

      const outputs: Array<ResponseInputItem> = []
      for (const call of calls) {
        const outcome = yield* Effect.gen(function* () {
          yield* Effect.logInfo(`Agent calls ${call.name}(${call.arguments})`)
          const outcome = yield* Effect.result(runToolCall(call))
          if (outcome._tag === "Success") {
            yield* Effect.logInfo(`${call.name} returned: ${preview(outcome.success)}`)
            yield* Effect.logDebug(`${call.name} full output:\n${outcome.success}`)
          } else yield* Effect.logWarning(`${call.name} failed: ${outcome.failure}`)
          return outcome
        }).pipe(Effect.withLogSpan(call.name), Effect.annotateLogs({ step, tool: call.name }))
        const ok = outcome._tag === "Success"
        const output = ok ? outcome.success : `Error: ${outcome.failure}`
        trace.push({ step, tool: call.name, args: call.arguments, ok, output })
        outputs.push({ type: "function_call_output", call_id: call.call_id, output })
      }
      input = outputs
      previousResponseId = response.id
    }

    return yield* stop("step-limit", `no answer after ${options.maxSteps} model calls`)
  })

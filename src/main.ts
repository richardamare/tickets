import { Console, Effect } from "effect"

const program = Console.log("Hello from Effect")

Effect.runPromise(program)

import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess } from "effect/process"

export const runCommand = (command: string, args: readonly string[]) => Effect.scoped(Effect.gen(function* () {
  const child = yield* ChildProcess.make(command, args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  const code = yield* child.exitCode
  if (Number(code) !== 0) return yield* Effect.fail(new Error(`${command} exited with status ${code}`))
}))

export const findExecutable = (name: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const search = yield* Config.String("PATH").pipe(Config.withDefault(""))
  for (const directory of search.split(path.sep === "\\" ? ";" : ":").filter(Boolean)) {
    const candidate = path.join(directory, name)
    const executable = yield* fs.stat(candidate).pipe(Effect.map((stat) => stat.type === "File" && (stat.mode & 0o111) !== 0), Effect.catch(() => Effect.succeed(false)))
    if (executable) return candidate
  }
  return undefined
})

export const notify = (title: string, message: string) => process.platform === "darwin"
  ? runCommand("osascript", ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", message, title]).pipe(Effect.ignore({ log: "Warn" }))
  : Effect.void

export const notifyUntilClicked = (notifier: string, title: string, message: string, group: string) => Effect.scoped(Effect.gen(function* () {
  yield* Effect.addFinalizer(() => runCommand(notifier, ["-remove", group]).pipe(Effect.ignore))
  const child = yield* ChildProcess.make(notifier, ["-title", title, "-message", message, "-sound", "default", "-group", group, "-action", "Open"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const [answer, code] = yield* Effect.all([child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], { concurrency: 2 })
  return Number(code) === 0 ? answer.trim() !== "@CLOSED" : undefined
}))

import { Cause, Config, Crypto, Data, Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export const BrowserKind = Schema.Literals(["chrome", "edge"])
export type BrowserKind = typeof BrowserKind.Type
export const BrowserSelection = Schema.Struct({ browser: BrowserKind, profile: Schema.String })
export type BrowserSelection = typeof BrowserSelection.Type
export const browserName = (browser: BrowserKind) => browser === "chrome" ? "Chrome" : "Edge"

export class ProfileError extends Data.TaggedError("ProfileError")<{ readonly message: string }> {}

const Settings = Schema.fromJsonString(BrowserSelection)
const Lease = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, token: Schema.String, operation: Schema.Literals(["setup", "copy"]), opened: Schema.optionalKey(Schema.Boolean) }))
const validName = (name: string) => /^[\w.-]+$/.test(name) && name !== "." && name !== ".."

export const makeBrowserProfiles = (directory?: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const host = (yield* spawner.string(ChildProcess.make("/bin/hostname"))).trim()
  const alive = (pid: number) => spawner.exitCode(ChildProcess.make("/bin/ps", ["-p", String(pid), "-o", "pid="], { stdout: "ignore", stderr: "ignore" })).pipe(Effect.flatMap((code) =>
    code === 0 ? Effect.succeed(true) : code === 1 ? Effect.succeed(false) : Effect.fail(new ProfileError({ message: `Cannot verify profile owner pid ${pid}; ps exited ${code}.` }))))
  const home = yield* Config.String("HOME")
  const root = directory ?? (yield* Config.String("TICKET_BROWSER_HOME").pipe(Config.withDefault(path.join(home, ".ticket-scraper", "browsers"))))
  const legacyRoot = path.join(home, ".ticket-scraper", "profiles")
  const validate = (selection: BrowserSelection) => Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(BrowserSelection)(selection)
    if (!validName(selection.profile)) return yield* new ProfileError({ message: `Invalid account '${selection.profile}'; use letters, digits, '.', '_' or '-'.` })
    return selection
  })
  const sourcePath = (selection: BrowserSelection) => path.join(root, selection.browser, selection.profile, "source")
  const leasePath = (selection: BrowserSelection) => path.join(root, selection.browser, selection.profile, "lease")
  const readyPath = (selection: BrowserSelection) => path.join(root, selection.browser, selection.profile, "ready")
  const setupErrorPath = (selection: BrowserSelection) => path.join(root, selection.browser, selection.profile, "setup-error.txt")
  const readSettings = Effect.gen(function* () {
    const file = path.join(root, "settings.json")
    if (!(yield* fs.exists(file))) return { browser: "chrome", profile: "default" } as const
    return yield* validate(yield* Schema.decodeUnknownEffect(Settings)(yield* fs.readFileString(file)))
  })
  const saveSettings = (selection: BrowserSelection) => Effect.scoped(Effect.gen(function* () {
    yield* validate(selection)
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 })
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: "settings-" })
    const file = path.join(temporary, "settings.json")
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(Settings)(selection), { mode: 0o600 })
    yield* fs.rename(file, path.join(root, "settings.json"))
  }))
  const resolveSelection = (browser?: BrowserKind, profile?: string) => Effect.gen(function* () {
    const saved = yield* readSettings
    return yield* validate({ browser: browser ?? saved.browser, profile: profile ?? (browser && browser !== saved.browser ? "default" : saved.profile) })
  })
  const assertClosed = (source: string) => Effect.gen(function* () {
    const target = yield* fs.readLink(path.join(source, "SingletonLock")).pipe(Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error)))
    if (target === undefined) return
    const match = /^(.*)-(\d+)$/.exec(target)
    if (!match || match[1] !== host || (yield* alive(Number(match[2])))) {
      return yield* new ProfileError({ message: `Browser profile ${source} is open or its owner cannot be verified. Close its browser before setup or copying.` })
    }
  })
  const clearRuntimeFiles = (source: string) => Effect.gen(function* () {
    yield* assertClosed(source)
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) {
      yield* fs.remove(path.join(source, name), { force: true })
    }
  })
  const acquireSource = (selection: BrowserSelection, operation: "setup" | "copy") => Effect.gen(function* () {
    yield* validate(selection)
    const lease = leasePath(selection)
    yield* fs.makeDirectory(path.dirname(lease), { recursive: true, mode: 0o700 })
    const token = yield* crypto.randomUUIDv4
    const claim = (remaining: number): Effect.Effect<void, import("effect/PlatformError").PlatformError | ProfileError> => fs.makeDirectory(lease, { mode: 0o700 }).pipe(Effect.catch((error) => Effect.gen(function* () {
      if (error.reason._tag !== "AlreadyExists") return yield* error
      const owner = yield* fs.readFileString(path.join(lease, "owner.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Lease)), Effect.option)
      if (owner._tag === "Some" && !(yield* alive(owner.value.pid))) {
        return yield* new ProfileError({ message: `A stale lease remains from pid ${owner.value.pid}. After checking no setup is running, remove ${lease} and retry.` })
      }
      if (operation === "copy" && remaining > 0 && (owner._tag === "None" || owner.value.operation === "copy")) {
        yield* Effect.sleep("100 millis")
        return yield* claim(remaining - 1)
      }
      return yield* new ProfileError({ message: `${browserName(selection.browser)} account '${selection.profile}' is locked. Another setup or profile copy is in progress. Wait for it to finish and retry.` })
    })))
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        yield* claim(300)
        yield* fs.writeFileString(path.join(lease, "owner.json"), yield* Schema.encodeEffect(Lease)({ pid: process.pid, token, operation }), { mode: 0o600 }).pipe(
          Effect.onError(() => fs.remove(lease, { recursive: true }).pipe(Effect.ignore)))
      }),
      () => Effect.gen(function* () {
        const owner = yield* Schema.decodeUnknownEffect(Lease)(yield* fs.readFileString(path.join(lease, "owner.json")))
        if (owner.token === token) yield* fs.remove(lease, { recursive: true })
      }).pipe(Effect.ignore({ log: "Warn" })),
    )
    const source = sourcePath(selection)
    yield* assertClosed(source)
    return source
  })
  const legacyPath = (selection: BrowserSelection) => selection.browser === "edge"
    ? selection.profile === "default" ? path.join(home, ".ticket-scraper", "edge-profile") : path.join(legacyRoot, selection.profile)
    : undefined
  const markReady = (selection: BrowserSelection) => fs.writeFileString(readyPath(selection), "ready\n", { mode: 0o600 })
  const ensureSource = (selection: BrowserSelection, source: string) => Effect.gen(function* () {
    if (yield* fs.exists(setupErrorPath(selection))) return yield* new ProfileError({ message: `${browserName(selection.browser)} account '${selection.profile}' setup failed. Reopen /setup to finish preparing it.` })
    if (yield* fs.exists(readyPath(selection))) return
    const legacy = legacyPath(selection)
    if (legacy && !(yield* fs.exists(source)) && (yield* fs.exists(path.join(legacy, "Default", "Preferences")))) {
      yield* assertClosed(legacy)
      yield* fs.copy(legacy, source)
      yield* clearRuntimeFiles(source)
      yield* fs.chmod(source, 0o700)
      yield* markReady(selection)
      return
    }
    return yield* new ProfileError({ message: `${browserName(selection.browser)} account '${selection.profile}' is not set up. Use /setup in the TUI or run 'profile ${selection.profile} --browser ${selection.browser}' and close the setup window first.` })
  })
  const status = (selection: BrowserSelection) => Effect.gen(function* () {
    yield* validate(selection)
    const lease = leasePath(selection)
    const locked = yield* fs.exists(lease)
    const owner = locked ? yield* fs.readFileString(path.join(lease, "owner.json")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Lease)), Effect.option) : undefined
    if (owner?._tag === "Some" && !(yield* alive(owner.value.pid))) {
      return yield* new ProfileError({ message: `A stale browser lease remains at ${lease} (pid ${owner.value.pid}). Check no setup is running, remove that lease directory and retry /setup.` })
    }
    const settingUp = locked && (owner === undefined || owner._tag === "None" || owner.value.operation === "setup")
    const legacy = legacyPath(selection)
    const ready = (yield* fs.exists(readyPath(selection))) || (!!legacy && (yield* fs.exists(path.join(legacy, "Default", "Preferences"))))
    const setupError = (yield* fs.exists(setupErrorPath(selection))) ? yield* fs.readFileString(setupErrorPath(selection)) : undefined
    return { ready: ready && !settingUp && setupError === undefined, settingUp, setupPid: settingUp && owner?._tag === "Some" ? owner.value.pid : undefined, setupOpened: settingUp && owner?._tag === "Some" && owner.value.opened === true, setupError }
  })
  const listProfiles = (browser: BrowserKind) => Effect.gen(function* () {
    const directory = path.join(root, browser)
    const names = (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : []
    if (browser === "edge") {
      if (yield* fs.exists(legacyRoot)) names.push(...yield* fs.readDirectory(legacyRoot))
      if (yield* fs.exists(path.join(home, ".ticket-scraper", "edge-profile", "Default", "Preferences"))) names.push("default")
    }
    return yield* Effect.filter([...new Set(names)].filter(validName).sort(), (profile) => status({ browser, profile }).pipe(Effect.map((state) => state.ready)))
  })
  const clone = (selection: BrowserSelection) => Effect.gen(function* () {
    yield* fs.makeDirectory(path.join(root, "runs"), { recursive: true, mode: 0o700 })
    const run = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ directory: path.join(root, "runs"), prefix: `${selection.browser}-` }),
      (run) => assertClosed(path.join(run, "profile")).pipe(
        Effect.andThen(fs.remove(run, { recursive: true })),
        Effect.ignore({ log: "Warn" }),
      ),
    )
    const target = path.join(run, "profile")
    yield* Effect.scoped(Effect.gen(function* () {
      const source = yield* acquireSource(selection, "copy")
      yield* ensureSource(selection, source)
      yield* fs.copy(source, target)
      yield* clearRuntimeFiles(target)
      yield* fs.chmod(target, 0o700)
    }))
    return target
  })
  const prepareSetup = (selection: BrowserSelection) => Effect.gen(function* () {
    const source = yield* acquireSource(selection, "setup")
    return yield* Effect.gen(function* () {
      const legacy = legacyPath(selection)
      if (!(yield* fs.exists(source)) && legacy && (yield* fs.exists(path.join(legacy, "Default", "Preferences")))) {
        yield* assertClosed(legacy)
        yield* fs.copy(legacy, source)
      }
      yield* fs.makeDirectory(source, { recursive: true, mode: 0o700 })
      yield* clearRuntimeFiles(source)
      yield* fs.remove(readyPath(selection), { force: true })
      yield* fs.remove(setupErrorPath(selection), { force: true })
      return source
    }).pipe(Effect.onError((cause) => markSetupFailed(selection, Cause.pretty(cause)).pipe(Effect.ignore({ log: "Warn" }))))
  })
  const markSetupOpened = (selection: BrowserSelection) => Effect.gen(function* () {
    const file = path.join(leasePath(selection), "owner.json")
    const owner = yield* Schema.decodeUnknownEffect(Lease)(yield* fs.readFileString(file))
    if (owner.pid !== process.pid || owner.operation !== "setup") return yield* new ProfileError({ message: "The setup lease is owned by another process." })
    const temporary = path.join(leasePath(selection), `${owner.token}.json`)
    yield* fs.writeFileString(temporary, yield* Schema.encodeEffect(Lease)({ ...owner, opened: true }), { mode: 0o600 })
    yield* fs.rename(temporary, file)
  })
  const markSetupFailed = (selection: BrowserSelection, message: string) => fs.writeFileString(setupErrorPath(selection), message, { mode: 0o600 }).pipe(
    Effect.andThen(fs.remove(readyPath(selection), { force: true })),
  )
  return { root, readSettings, saveSettings, listProfiles, status, resolveSelection, clone, prepareSetup, markReady, assertClosed, markSetupOpened, markSetupFailed }
})

export const ensureBrowserInstalled = (browser: BrowserKind) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const executable = browser === "chrome"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  if (!(yield* fs.exists(executable))) return yield* new ProfileError({ message: `${browserName(browser)} is not installed at ${executable}. Install it or choose the other browser in /setup.` })
  yield* fs.access(executable, { readable: true })
  return executable
})

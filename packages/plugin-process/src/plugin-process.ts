import { type ChildProcess, spawn } from "node:child_process"

export interface PluginProcessOptions {
  /** Run as `spawn` runs it, with no shell between. */
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** Merged over the host's environment; a variable set to `undefined` is left out. */
  readonly env?: NodeJS.ProcessEnv
  /** How long one request may wait for its answer, the process's own start included. */
  readonly timeoutMs?: number
  /** The longest line the process may write on stdout, in bytes. */
  readonly maxResponseBytes?: number
}

export interface RequestOptions {
  /** In place of the process's `timeoutMs`, for a request known to take longer or shorter. */
  readonly timeoutMs?: number
}

export interface PluginProcess {
  /** Sends one JSON-RPC request and resolves with its `result`, starting the process if none runs. */
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>
  /** Ends the process, if one runs. A later request starts another. */
  close(): Promise<void>
}

export type PluginProcessErrorCode =
  | "start-failed"
  | "exited"
  | "timeout"
  | "oversize"
  | "protocol"
  | "error-response"
  | "abandoned"
  | "closed"

/** The `error` member of a JSON-RPC answer. */
export interface RpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export class PluginProcessError extends Error {
  readonly code: PluginProcessErrorCode
  /** What the process answered with, on an `error-response`. */
  readonly rpcError: RpcError | undefined

  constructor(
    message: string,
    code: PluginProcessErrorCode,
    options?: { cause?: unknown; rpcError?: RpcError },
  ) {
    super(message, options !== undefined && "cause" in options ? { cause: options.cause } : {})
    this.name = "PluginProcessError"
    this.code = code
    this.rpcError = options?.rpcError
  }
}

const CODES: ReadonlySet<string> = new Set<PluginProcessErrorCode>([
  "start-failed",
  "exited",
  "timeout",
  "oversize",
  "protocol",
  "error-response",
  "abandoned",
  "closed",
])

/** Matched by name and code, so a copy of this package installed twice still recognises it. */
export function isPluginProcessError(error: unknown): error is PluginProcessError {
  if (!(error instanceof Error) || error.name !== "PluginProcessError") return false
  const { code } = error as { code?: unknown }
  return typeof code === "string" && CODES.has(code)
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024
// A longer delay is read by `setTimeout` as 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1
/** From closing its stdin, which a peer reading to the end of it takes to exit on, to SIGTERM. */
const END_GRACE_MS = 1_000
const KILL_AFTER_MS = 5_000
/** From SIGKILL to no longer waiting for an exit that cannot then be helped. */
const GIVE_UP_AFTER_MS = 5_000
// A process that leaves a child of its own holding its pipes would never close them.
const DRAIN_AFTER_EXIT_MS = 1_000
const STDERR_TAIL_CHARS = 8 * 1024
const NEWLINE = 0x0a
// A process that dies before answering anything three times running will not answer the next
// request either, and starting it once per file would cost a scan thousands of starts.
const MAX_SILENT_ENDS = 3

interface Pending {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: PluginProcessError) => void
  readonly timer: NodeJS.Timeout
}

export function createPluginProcess(options: PluginProcessOptions): PluginProcess {
  const timeoutMs = timeoutOf(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  )
  const name = [options.command, ...(options.args ?? [])].join(" ")
  let running: Running | null = null
  const ending = new Set<Promise<void>>()
  let silentEnds = 0
  let lastEnd: PluginProcessError | null = null
  let nextId = 1

  const start = (): Running => {
    const started = new Running(name, options, maxResponseBytes, (answered, why) => {
      if (running === started) running = null
      if (answered) {
        silentEnds = 0
      } else {
        silentEnds += 1
        lastEnd = why
      }
    })
    ending.add(started.closed)
    void started.closed.then(() => ending.delete(started.closed))
    return started
  }

  return {
    async request(method, params, requestOptions = {}) {
      const waitMs =
        requestOptions.timeoutMs === undefined ? timeoutMs : timeoutOf(requestOptions.timeoutMs)
      if (silentEnds >= MAX_SILENT_ENDS) {
        throw new PluginProcessError(
          `${name} ended ${MAX_SILENT_ENDS} times without answering a request, so no more are sent to it. The last time: ${lastEnd?.message ?? "no reason was given"}`,
          "abandoned",
          { cause: lastEnd },
        )
      }
      const id = nextId++
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })
      running ??= start()
      return running.send(id, method, `${message}\n`, waitMs)
    },
    async close() {
      const current = running
      running = null
      current?.end(new PluginProcessError(`${name} was closed before it answered`, "closed"))
      silentEnds = 0
      lastEnd = null
      await Promise.all(ending)
    },
  }
}

/** One start of the process, from spawn to exit. */
class Running {
  readonly closed: Promise<void>
  private readonly child: ChildProcess | null
  private readonly pending = new Map<number, Pending>()
  private readonly line: Buffer[] = []
  private lineBytes = 0
  private stderrTail = ""
  private stdinError: Error | null = null
  private answered = false
  private exited = false
  private stopping = false
  private settled = false
  private failure: PluginProcessError | null = null
  /** The next step of ending the process, or of waiting for its pipes. */
  private step: NodeJS.Timeout | undefined
  private done: () => void = () => {}

  constructor(
    private readonly name: string,
    options: PluginProcessOptions,
    private readonly maxResponseBytes: number,
    private readonly onEnd: (answered: boolean, why: PluginProcessError) => void,
  ) {
    this.closed = new Promise((done) => {
      this.done = done
    })
    let child: ChildProcess
    try {
      child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      // Some commands are refused at once rather than with an `error` event: an empty one, or a
      // `.cmd` on Windows, which runs only through `cmd.exe`.
      this.child = null
      const failure = this.startFailed(error, options.command)
      queueMicrotask(() => {
        this.fail(failure)
        this.settle()
      })
      return
    }
    this.child = child
    child.on("error", (error) => {
      // Once the process has started, an `error` is a failed signal, and its exit still follows.
      if (child.pid !== undefined) return
      this.fail(this.startFailed(error, options.command))
      this.settle()
    })
    // Pending requests hold their timers, which keep the event loop alive while they wait; an
    // idle process must not, so a plugin that never closes it still lets its host exit.
    child.unref()
    // A process the system could not give pipes to, as when it is out of file descriptors, has
    // none; its `error` follows.
    const { stdin, stdout, stderr } = child
    if (stdin === null || stdout === null || stderr === null) return
    for (const stream of [stdin, stdout, stderr]) unref(stream)
    stdin.on("error", (error) => {
      // The process has stopped reading its requests, so none sent will be answered.
      this.stdinError ??= error
      this.stop()
    })
    stdout.on("data", (chunk: Buffer) => this.read(chunk))
    stderr.setEncoding("utf8")
    stderr.on("data", (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS)
    })
    child.on("exit", () => {
      this.exited = true
      clearTimeout(this.step)
      this.step = setTimeout(() => {
        stdout.destroy()
        stderr.destroy()
      }, DRAIN_AFTER_EXIT_MS)
    })
    child.on("close", (code, signal) => {
      const stdinClosed =
        this.stdinError === null ? "" : `. Its stdin had closed: ${this.stdinError.message}`
      this.fail(
        new PluginProcessError(
          `${this.name} ${signal === null ? `exited with code ${code}` : `ended on ${signal}`}${stdinClosed}${this.quotedStderr()}`,
          "exited",
          this.stdinError === null ? undefined : { cause: this.stdinError },
        ),
      )
      this.settle()
    })
  }

  send(id: number, method: string, line: string, timeoutMs: number): Promise<unknown> {
    if (this.failure !== null) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reject(
          id,
          new PluginProcessError(
            `${this.name} did not answer ${method} within ${timeoutMs}ms`,
            "timeout",
          ),
        )
        this.end(
          new PluginProcessError(
            `${this.name} was ended because it did not answer ${method} within ${timeoutMs}ms`,
            "exited",
          ),
        )
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.child?.stdin?.write(line)
    })
  }

  /** Rejects what is still waiting with `why` and ends the process. */
  end(why: PluginProcessError): void {
    this.fail(why)
    this.stop()
  }

  /**
   * Closes the process's stdin, then sends SIGTERM and, if it holds that, SIGKILL. The host is kept
   * alive until the process has exited, so a host that awaits `close` sees it resolve.
   */
  private stop(): void {
    const { child } = this
    if (child === null || this.exited || this.stopping) return
    this.stopping = true
    child.stdin?.end()
    this.step = setTimeout(() => {
      child.kill("SIGTERM")
      this.step = setTimeout(() => {
        child.kill("SIGKILL")
        this.step = setTimeout(() => {
          this.fail(new PluginProcessError(`${this.name} did not exit after SIGKILL`, "exited"))
          this.settle()
        }, GIVE_UP_AFTER_MS)
      }, KILL_AFTER_MS)
    }, END_GRACE_MS)
  }

  private read(chunk: Buffer): void {
    let start = 0
    for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, start)) {
      if (!this.take(chunk.subarray(start, at))) return
      this.answer(Buffer.concat(this.line).toString("utf8"))
      this.line.length = 0
      this.lineBytes = 0
      start = at + 1
    }
    this.take(chunk.subarray(start))
  }

  private take(part: Buffer): boolean {
    this.lineBytes += part.length
    if (this.lineBytes > this.maxResponseBytes) {
      this.end(
        new PluginProcessError(
          `${this.name} wrote a line longer than maxResponseBytes (${this.maxResponseBytes} bytes)`,
          "oversize",
        ),
      )
      return false
    }
    this.line.push(part)
    return true
  }

  private answer(text: string): void {
    if (this.failure !== null || text.trim().length === 0) return
    const response = parseResponse(text)
    const waiting = response === null ? undefined : this.pending.get(response.id)
    if (response === null || waiting === undefined) {
      this.end(
        new PluginProcessError(
          `${this.name} wrote a line on stdout that answers no request it was sent: ${clip(text)}`,
          "protocol",
        ),
      )
      return
    }
    this.answered = true
    this.pending.delete(response.id)
    clearTimeout(waiting.timer)
    if ("error" in response) {
      waiting.reject(
        new PluginProcessError(
          `${this.name} answered ${waiting.method} with an error: ${response.error.message}`,
          "error-response",
          { rpcError: response.error },
        ),
      )
    } else {
      waiting.resolve(response.result)
    }
  }

  private reject(id: number, error: PluginProcessError): void {
    const waiting = this.pending.get(id)
    if (waiting === undefined) return
    this.pending.delete(id)
    clearTimeout(waiting.timer)
    waiting.reject(error)
  }

  private fail(why: PluginProcessError): void {
    if (this.failure === null) {
      this.failure = why
      this.onEnd(this.answered, why)
    }
    for (const id of [...this.pending.keys()]) this.reject(id, this.failure)
  }

  private settle(): void {
    if (this.settled) return
    this.settled = true
    clearTimeout(this.step)
    this.done()
  }

  private startFailed(error: unknown, command: string): PluginProcessError {
    const reason = error instanceof Error ? error.message : String(error)
    const shim =
      /\.(cmd|bat)$/i.test(command) && (error as { code?: unknown }).code === "EINVAL"
        ? '. A .cmd or .bat runs only through cmd.exe: make "cmd.exe" the command, with "/c" and the script first among the args'
        : ""
    return new PluginProcessError(
      `Could not start ${this.name}: ${reason}${shim}`,
      "start-failed",
      {
        cause: error,
      },
    )
  }

  private quotedStderr(): string {
    const tail = this.stderrTail.trimEnd()
    return tail.length === 0 ? "" : `. It wrote on stderr:\n${tail}`
  }
}

type Response = { id: number; result: unknown } | { id: number; error: RpcError }

function parseResponse(text: string): Response | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const { id } = value
  if (typeof id !== "number") return null
  // JSON-RPC answers with one of the two, never both.
  if ("result" in value === "error" in value) return null
  if ("result" in value) return { id, result: value.result }
  const error = rpcErrorOf(value.error)
  return error === null ? null : { id, error }
}

function rpcErrorOf(value: unknown): RpcError | null {
  if (!isRecord(value)) return null
  const { code, message } = value
  if (typeof code !== "number" || !Number.isInteger(code) || typeof message !== "string") {
    return null
  }
  return { code, message, ...("data" in value ? { data: value.data } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clip(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function unref(stream: object): void {
  const handle = stream as { unref?: () => void }
  handle.unref?.()
}

function timeoutOf(value: number): number {
  return Math.min(positiveInteger(value, "timeoutMs"), MAX_TIMER_MS)
}

function positiveInteger(value: number, option: string): number {
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new RangeError(`${option} must be a positive integer (got ${String(value)})`)
}

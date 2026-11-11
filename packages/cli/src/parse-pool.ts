import { createRequire } from "node:module"
import { parentPort, Worker, workerData } from "node:worker_threads"
import { frameworkHintPlugins } from "@aburi/config"
import {
  createFileExtractor,
  type ExtractionEvent,
  type ExtractionJob,
  type FileExtraction,
  type FileExtractor,
  type FileOutcome,
  initializePlugins,
  isPluginSetFault,
  type ParsePool,
  type PluginCleanup,
} from "@aburi/core"
import type { Config, Logger } from "@aburi/types"
import { CliError, errorCode, errorMessage, internalFault } from "./errors"
import { loadPlugins } from "./plugin-loader"
import {
  describedForThread,
  ifCloneable,
  rebuiltFromThread,
  type ThreadThrown,
} from "./thread-errors"
import { WORKER_STACK_MB } from "./worker-stack"

/** What a parser worker loads the scan's plugins from: what the scan itself loaded them from. */
export interface ParserSetup {
  /** The config the scan read, with the options the command line overrode. */
  readonly config: Config
  readonly workspaceRoot: string
  readonly pluginRefRoot: string
}

export interface ParsePoolOptions {
  readonly size: number
  readonly setup: ParserSetup
  /** Where what the workers' plugins log as they initialize and clean up is said. */
  readonly logger: Logger
}

interface ParserData {
  readonly job: ExtractionJob
  readonly setup: ParserSetup
}

type ToWorker =
  | { readonly kind: "extract"; readonly fileId: number }
  /** Clean up the plugins once the file in hand is done, and begin no other. */
  | { readonly kind: "close" }

/** A line a worker's plugins logged initializing or cleaning up, outside any file. */
interface PluginLine {
  readonly level: keyof Logger
  readonly message: string
  readonly meta?: Record<string, unknown>
}

/** A file's outcome as it crosses: the error of a `fatal` one described, as a clone would lose it. */
type WireOutcome =
  | Exclude<FileOutcome, { readonly kind: "fatal" }>
  | { readonly kind: "fatal"; readonly thrown: ThreadThrown }

interface WireExtraction extends Omit<FileExtraction, "outcome"> {
  readonly outcome: WireOutcome
}

type FromWorker =
  | { readonly kind: "ready"; readonly said: readonly PluginLine[] }
  /** The plugins could not be loaded or initialized. */
  | { readonly kind: "failed"; readonly thrown: ThreadThrown; readonly said: readonly PluginLine[] }
  | { readonly kind: "extracted"; readonly extraction: WireExtraction }
  /** Extracting the file rejected, which ends the run at that file as on one thread. */
  | { readonly kind: "rejected"; readonly fileId: number; readonly thrown: ThreadThrown }
  /** The worker's plugins are cleaned up, or were never initialized. */
  | { readonly kind: "closed"; readonly said: readonly PluginLine[] }

interface Pending {
  readonly fileId: number
  resolve(extraction: FileExtraction): void
  reject(error: unknown): void
}

interface Slot {
  readonly worker: Worker
  readonly inFlight: Pending[]
  /** Its plugins are loaded and initialized. */
  ready: boolean
  /** The pool reads nothing more of it but `closed`: it has exited, or is cleaning up to. */
  ended: boolean
  /** What the worker's `error` said, for the `exit` that follows it. */
  endedBecause: string | undefined
}

/** Two, so a worker has its next file before it answers for the one it has. */
const IN_FLIGHT_PER_WORKER = 2

const ENDS_BEFORE_ABORT = 3

const ON_THE_MAIN_THREAD = "Run with --concurrency 1 to extract every file on the main thread."

/**
 * Workers that each load and initialize the scan's plugins and extract the files they are handed,
 * one at a time and in the order they were asked for, cleaning the plugins up as they leave. A
 * worker that ends under a file withdraws that file and is replaced; the third that ends stops the
 * pool.
 */
export function createParsePool(job: ExtractionJob, options: ParsePoolOptions): ParsePool {
  const queue: Pending[] = []
  const slots: Slot[] = []
  // A replaced worker may still be cleaning up, so the pool waits on every worker it started.
  const exits: Promise<void>[] = []
  const ended: string[] = []
  let stopped: unknown = null
  const data: ParserData = { job, setup: options.setup }
  const path = parserWorkerPath()

  const fileOf = (fileId: number): string => job.files[fileId]?.path ?? `file ${fileId}`

  // Each worker's plugins say what one thread's would, so a line is said once however many say it.
  const heard = new Set<string>()
  const say = (lines: readonly PluginLine[]): void => {
    for (const { level, message, meta } of lines) {
      const key = `${level}\0${message}`
      if (heard.has(key)) continue
      heard.add(key)
      options.logger[level](message, meta)
    }
  }

  const retire = (slot: Slot): void => {
    if (slot.ended) return
    slot.ended = true
    slot.worker.postMessage({ kind: "close" } satisfies ToWorker)
  }

  const stop = (error: unknown): void => {
    if (stopped !== null) return
    stopped = error
    const pending = [...slots.flatMap((slot) => slot.inFlight.splice(0)), ...queue.splice(0)]
    for (const entry of pending) entry.reject(error)
    for (const slot of slots) retire(slot)
  }

  const dispatch = (): void => {
    if (stopped !== null) return
    for (let depth = 1; depth <= IN_FLIGHT_PER_WORKER; depth++) {
      for (const [index, slot] of slots.entries()) {
        if (queue.length === 0) return
        const live = slot.ended ? spawn(index) : slot
        if (live === null) return
        if (live.inFlight.length >= depth) continue
        const next = queue.shift()
        if (next === undefined) return
        live.inFlight.push(next)
        live.worker.postMessage({ kind: "extract", fileId: next.fileId } satisfies ToWorker)
      }
    }
  }

  const received = (slot: Slot, message: FromWorker): void => {
    if (message.kind === "closed") {
      say(message.said)
      void slot.worker.terminate()
      return
    }
    if (slot.ended) return
    switch (message.kind) {
      case "ready":
        say(message.said)
        slot.ready = true
        return
      case "failed": {
        say(message.said)
        const error = rebuiltFromThread(message.thrown)
        // A plugin whose `init` fails ends the run as it would on one thread.
        stop(
          isPluginSetFault(error)
            ? error
            : new CliError(
                `A parser worker failed: ${errorMessage(error)}\n${ON_THE_MAIN_THREAD}`,
                "runtime-error",
                { cause: error },
              ),
        )
        return
      }
      case "extracted":
        answeredFor(slot, message.extraction.fileId)?.resolve(fromWire(message.extraction))
        dispatch()
        return
      case "rejected":
        answeredFor(slot, message.fileId)?.reject(rebuiltFromThread(message.thrown))
        dispatch()
        return
      default:
        stop(
          internalFault(
            " while extracting files on parser workers",
            `a worker sent ${JSON.stringify(message satisfies never)}, a message of no known kind`,
            null,
          ),
        )
    }
  }

  /** The worker's next file, which an answer for `fileId` settles; none stops the pool. */
  const answeredFor = (slot: Slot, fileId: number): Pending | undefined => {
    const next = slot.inFlight[0]
    if (next?.fileId === fileId) return slot.inFlight.shift()
    stop(
      internalFault(
        " while extracting files on parser workers",
        `a worker answered for ${fileOf(fileId)} while ${next === undefined ? "it had no file" : `${fileOf(next.fileId)} was its next`}`,
        null,
      ),
    )
    return undefined
  }

  const endedUnder = (slot: Slot, how: string): void => {
    if (slot.ended || stopped !== null) return
    // One that is still running, its answer unread, cleans up its plugins as it goes.
    retire(slot)
    if (!slot.ready) {
      stop(
        new CliError(
          `A parser worker ${how} before it had loaded the scan's plugins.\n${ON_THE_MAIN_THREAD}`,
          "runtime-error",
        ),
      )
      return
    }
    const culprit = slot.inFlight[0]
    ended.push(culprit === undefined ? "between files" : `extracting ${fileOf(culprit.fileId)}`)
    if (ended.length >= ENDS_BEFORE_ABORT) {
      stop(
        new CliError(
          `Parser workers ended ${ended.length} times (${ended.join("; ")}), so the plugins, not ` +
            `one file, are ending them. ${ON_THE_MAIN_THREAD}`,
          "runtime-error",
        ),
      )
      return
    }
    slot.inFlight.shift()
    queue.unshift(...slot.inFlight.splice(0))
    culprit?.resolve({
      fileId: culprit.fileId,
      outcome: {
        kind: "crashed",
        detail: `the parser worker extracting it ${how}. ${ON_THE_MAIN_THREAD}`,
      },
      events: [],
    })
    dispatch()
  }

  const spawn = (index: number): Slot | null => {
    let worker: Worker
    try {
      worker = new Worker(path, {
        workerData: data,
        resourceLimits: { stackSizeMb: WORKER_STACK_MB },
      })
    } catch (error) {
      stop(
        new CliError(
          `A parser worker could not be started: ${errorMessage(error)}\n${ON_THE_MAIN_THREAD}`,
          "runtime-error",
          { cause: error },
        ),
      )
      return null
    }
    const slot: Slot = { worker, inFlight: [], ready: false, ended: false, endedBecause: undefined }
    exits.push(new Promise((resolve) => worker.once("exit", () => resolve())))
    worker.on("message", (message: FromWorker) => received(slot, message))
    // The answer is dropped, and the worker, still running, would never send it again.
    worker.on("messageerror", (error) =>
      endedUnder(
        slot,
        `sent an answer that could not be read: ${withoutFullStop(errorMessage(error))}`,
      ),
    )
    // An `error` can overtake answers the worker sent before it; its `exit` comes after them all.
    worker.on("error", (error: unknown) => {
      slot.endedBecause ??= describeWorkerError(error)
    })
    worker.on("exit", (code) =>
      endedUnder(
        slot,
        slot.endedBecause ??
          `ended with exit code ${code}; a plugin may have called process.exit()`,
      ),
    )
    slots[index] = slot
    return slot
  }

  for (let index = 0; index < options.size; index++) {
    if (spawn(index) === null) break
  }

  return {
    extract(fileId) {
      return new Promise<FileExtraction>((resolve, reject) => {
        if (stopped !== null) {
          reject(stopped)
          return
        }
        queue.push({ fileId, resolve, reject })
        dispatch()
      })
    },
    async close() {
      stop(new CliError("The parser workers were stopped before they finished.", "runtime-error"))
      await Promise.all(exits)
    },
  }
}

/** The worker's side of `createParsePool`. */
export function serveParseRequests(): void {
  const port = parentPort
  if (port === null) {
    throw internalFault(" while serving parse requests", "it ran outside a worker thread", null)
  }
  const send = (message: FromWorker): void => port.postMessage(message)
  const { job, setup } = workerData as ParserData
  const lines: PluginLine[] = []
  const said = (): PluginLine[] => lines.splice(0)
  const log = lineLogger(lines)
  let closing = false
  let initializing = false
  const ready: Promise<{ extractor: FileExtractor; cleanUp: PluginCleanup } | null> = loadPlugins({
    config: setup.config,
    workspaceRoot: setup.workspaceRoot,
    pluginRefRoot: setup.pluginRefRoot,
    syntheticPlugins: frameworkHintPlugins(setup.config),
  }).then(async (plugins) => {
    if (closing) return null
    initializing = true
    const cleanUp = await initializePlugins(plugins, job, log)
    return { extractor: createFileExtractor(job, plugins), cleanUp }
  })
  ready.then(
    (set) => {
      if (set !== null) send({ kind: "ready", said: said() })
    },
    (error: unknown) => send({ kind: "failed", thrown: describedForThread(error), said: said() }),
  )
  const running = new Set<Promise<unknown>>()
  const extract = (fileId: number): void => {
    const extraction = ready.then(
      (set) =>
        // The pool has handed a retired worker's files on, or stopped.
        closing
          ? undefined
          : set?.extractor.extract(fileId).then(
              (extraction) => sendExtraction(extraction, send),
              (error: unknown) =>
                send({ kind: "rejected", fileId, thrown: describedForThread(error) }),
            ),
      // Said once, as `failed`, however many files were asked for.
      () => {},
    )
    running.add(extraction)
    void extraction.finally(() => running.delete(extraction))
  }
  const close = (): void => {
    if (closing) return
    closing = true
    if (!initializing) {
      send({ kind: "closed", said: [] })
      return
    }
    ready
      .then(
        async (set) => {
          await Promise.allSettled(running)
          await set?.cleanUp()
        },
        // Whatever it had initialized was cleaned up as its `init` failed.
        () => {},
      )
      .then(() => send({ kind: "closed", said: said() }))
  }
  port.on("message", (message: ToWorker) => {
    if (message.kind === "close") close()
    else if (!closing) extract(message.fileId)
  })
}

/** A logger that keeps each line, with only the metadata a clone can carry. */
function lineLogger(lines: PluginLine[]): Logger {
  const keep =
    (level: keyof Logger) =>
    (message: string, meta?: Record<string, unknown>): void => {
      const cloneable = ifCloneable(meta) as Record<string, unknown> | undefined
      lines.push({
        level,
        message: String(message),
        ...(cloneable === undefined ? {} : { meta: cloneable }),
      })
    }
  return { debug: keep("debug"), info: keep("info"), warn: keep("warn"), error: keep("error") }
}

/** Sends a file's extraction, or the file withdrawn, with what it said where that can be sent. */
export function sendExtraction(
  extraction: FileExtraction,
  send: (message: FromWorker) => void,
): void {
  const answer = portable(extraction)
  try {
    send(answer)
  } catch (error) {
    const withdrawn = uncloneable(answer.extraction, error)
    try {
      send(withdrawn)
    } catch {
      // What the file said cannot be cloned either, as a log line a plugin wrote as no string.
      send({ ...withdrawn, extraction: { ...withdrawn.extraction, events: [] } })
    }
  }
}

function uncloneable(
  extraction: WireExtraction,
  error: unknown,
): Extract<FromWorker, { kind: "extracted" }> {
  return {
    kind: "extracted",
    extraction: {
      fileId: extraction.fileId,
      outcome: {
        kind: "threw",
        message:
          "its extraction holds a value that cannot leave the parser worker: " +
          `${withoutFullStop(errorMessage(error))}. ${ON_THE_MAIN_THREAD}`,
        code: "extraction-uncloneable",
      },
      events: extraction.events,
    },
  }
}

/** What a worker sends of a file's extraction, which a structured clone can carry whole. */
function portable(extraction: FileExtraction): Extract<FromWorker, { kind: "extracted" }> {
  const { outcome } = extraction
  return {
    kind: "extracted",
    extraction: {
      ...extraction,
      events: extraction.events.map(withCloneableMeta),
      outcome:
        outcome.kind === "fatal"
          ? { kind: "fatal", thrown: describedForThread(outcome.error) }
          : outcome,
    },
  }
}

function fromWire(extraction: WireExtraction): FileExtraction {
  const { outcome } = extraction
  return {
    ...extraction,
    outcome:
      outcome.kind === "fatal"
        ? { kind: "fatal", error: rebuiltFromThread(outcome.thrown) }
        : outcome,
  }
}

function withCloneableMeta(event: ExtractionEvent): ExtractionEvent {
  if (!("meta" in event) || event.meta === undefined) return event
  const meta = ifCloneable(event.meta) as Record<string, unknown> | undefined
  if (meta !== undefined) return event
  const { meta: _dropped, ...rest } = event
  return rest
}

/** What ended a worker, from its `error`, which is any value a plugin threw from a callback. */
export function describeWorkerError(error: unknown): string {
  if (errorCode(error) === "ERR_WORKER_OUT_OF_MEMORY") {
    return `ran out of memory: ${errorMessage(error)}`
  }
  const thrown = error instanceof Error ? (error.stack ?? error.message) : String(error)
  return `threw outside the scan's own error handling: ${thrown}`
}

function withoutFullStop(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text
}

function parserWorkerPath(): string {
  try {
    return createRequire(import.meta.url).resolve("#parse-worker")
  } catch (error) {
    // A bundle that inlines @aburi/cli leaves its worker script behind.
    throw new CliError(
      `The worker script that extracts files on parser workers cannot be found from ${import.meta.url}. ${ON_THE_MAIN_THREAD}`,
      "runtime-error",
      { cause: error },
    )
  }
}

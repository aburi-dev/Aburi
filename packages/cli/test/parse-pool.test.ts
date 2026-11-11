import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import type { ExtractionJob, ParsePool } from "@aburi/core"
import { relativePath, useScratchWorkspace } from "@aburi/test-support"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadPinnedConfig, pinConfig } from "../src/config-load"
import { errorMessage } from "../src/errors"
import { createParsePool, describeWorkerError, portable } from "../src/parse-pool"
import { STUB_PLUGIN, workerEndingPlugin, writeStubWorkspace } from "./stub-language"
import { writeFileAt } from "./workspace"

/** What the pool's threads do beyond what a real one would, as each case sets it. */
const threads = vi.hoisted(() => ({
  started: [] as Worker[],
  attempts: 0,
  /** The attempt, counted from 1, whose `new Worker` throws as it does when no thread can start. */
  refusedAt: undefined as number | undefined,
  /** A message the main thread receives as one it cannot read. */
  unreadable: undefined as ((message: unknown) => boolean) | undefined,
  /** Whether the worker script is missing, as from a bundle that inlined the package. */
  scriptless: false,
}))

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>()
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      threads.attempts++
      if (threads.attempts === threads.refusedAt) {
        throw Object.assign(new Error("thread limit reached"), { code: "ERR_WORKER_INIT_FAILED" })
      }
      super(...args)
      threads.started.push(this)
    }

    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event === "message" && threads.unreadable?.(args[0]) === true) {
        return super.emit("messageerror", new Error("Unable to deserialize cloned data."))
      }
      return super.emit(event, ...args)
    }
  }
  return { ...actual, Worker: RecordedWorker }
})

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>()
  return {
    ...actual,
    createRequire: (from: string | URL) =>
      new Proxy(actual.createRequire(from), {
        get: (require, key) =>
          key === "resolve"
            ? (id: string, options?: { paths?: string[] }) => {
                if (threads.scriptless && id === "#parse-worker") {
                  throw Object.assign(new Error(`Cannot find module '${id}'`), {
                    code: "MODULE_NOT_FOUND",
                  })
                }
                return require.resolve(id, options)
              }
            : Reflect.get(require, key),
      }),
  }
})

const workspace = useScratchWorkspace("parse-pool")
const pools: ParsePool[] = []

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()))
  threads.started = []
  threads.attempts = 0
  threads.refusedAt = undefined
  threads.unreadable = undefined
  threads.scriptless = false
})

/** A pool of `size` parser workers over a stub workspace holding `files`, extracted by `plugin`. */
async function poolOver(
  files: readonly string[],
  plugin: string,
  size: number,
): Promise<ParsePool> {
  await writeStubWorkspace(workspace.root, files)
  await writeFileAt(workspace.root, "lang-stub.mjs", plugin)
  const { config } = await loadPinnedConfig(await pinConfig(workspace.root, undefined))
  const job: ExtractionJob = {
    workspaceRoot: workspace.root,
    files: files.map((file) => ({ path: relativePath(file), fsPath: file, size: file.length })),
    config,
    components: [],
  }
  const pool = createParsePool(job, {
    size,
    setup: { config, workspaceRoot: workspace.root, pluginRefRoot: workspace.root },
  })
  pools.push(pool)
  return pool
}

interface Answer {
  /** The file's outcome, or `refused` for a file the pool rejected. */
  kind: string
  /** What a withdrawn file was withdrawn with, or what the pool rejected one with. */
  said?: string
}

async function answersOf(pool: ParsePool, files: readonly string[]): Promise<Answer[]> {
  const answers = await Promise.allSettled(files.map((_, fileId) => pool.extract(fileId)))
  return answers.map((answer): Answer => {
    if (answer.status === "rejected") return { kind: "refused", said: errorMessage(answer.reason) }
    const { outcome } = answer.value
    return outcome.kind === "crashed"
      ? { kind: "crashed", said: outcome.detail }
      : { kind: outcome.kind }
  })
}

const pause = new Int32Array(new SharedArrayBuffer(4))

/** Keeps this thread busy, as a scan folding answers is, until `done`, and a little past it. */
function holdThreadUntil(done: () => boolean): void {
  const deadline = Date.now() + 30_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error("gave up holding the thread")
    Atomics.wait(pause, 0, 0, 10)
  }
  // Long enough for the worker to send what it threw.
  Atomics.wait(pause, 0, 0, 100)
}

const NOT_STARTED =
  "A parser worker could not be started: thread limit reached\n" +
  "Run with --concurrency 1 to extract every file on the main thread."

describe("a parser worker that throws outside the scan's own handling", () => {
  it.each<[string, string[], string[]]>([
    ["the file it answered for first", ["a-ok.stub", "b-crash.stub"], ["ran", "crashed"]],
    [
      "its first file, as it had loaded the scan's plugins",
      ["a-crash.stub", "b-ok.stub"],
      ["crashed", "ran"],
    ],
  ])(
    "withdraws the file it threw under, not %s, however its error is delivered",
    async (_case, files, kinds) => {
      const thrown = join(workspace.root, "thrown")
      // A threadpool job a worker cannot cancel holds its teardown open, so its error waits for this
      // thread together with the answers sent before it, and without the `exit` that follows them.
      const pool = await poolOver(
        files,
        workerEndingPlugin(`      const { pbkdf2 } = await import("node:crypto")
      const { writeFileSync } = await import("node:fs")
      pbkdf2("aburi", "salt", 2_000_000, 64, "sha512", () => {})
      setImmediate(() => {
        writeFileSync(${JSON.stringify(thrown)}, "")
        throw new Error("escaped the scan")
      })
      await new Promise(() => {})`),
        1,
      )
      const answers = answersOf(pool, files)
      holdThreadUntil(() => existsSync(thrown))

      expect((await answers).map((answer) => answer.kind)).toEqual(kinds)
    },
  )
})

describe("a parser worker that cannot be started", () => {
  it.each<[string, readonly string[], string, number, Answer[]]>([
    [
      "as the pool starts",
      ["a-ok.stub", "b-ok.stub"],
      STUB_PLUGIN,
      2,
      [
        { kind: "refused", said: NOT_STARTED },
        { kind: "refused", said: NOT_STARTED },
      ],
    ],
    [
      "in place of one that ended",
      ["a-crash.stub", "b-ok.stub"],
      workerEndingPlugin("      process.exit(7)"),
      1,
      [
        { kind: "crashed", said: expect.stringContaining("ended with exit code 7") },
        { kind: "refused", said: NOT_STARTED },
      ],
    ],
  ])(
    "stops the pool %s, and ends the workers it started",
    async (_case, files, plugin, size, answers) => {
      threads.refusedAt = 2
      const pool = await poolOver(files, plugin, size)

      expect(await answersOf(pool, files)).toEqual(answers)
      await vi.waitFor(() => {
        expect(threads.started.map((worker) => worker.threadId)).toEqual([-1])
      })
    },
  )
})

describe("a parser worker whose answer cannot be read", () => {
  it("withdraws that file, and extracts the rest on a new worker", async () => {
    const files = ["a-ok.stub", "b-ok.stub", "c-ok.stub"]
    threads.unreadable = (message) =>
      (message as { extraction?: { fileId?: number } }).extraction?.fileId === 1
    const pool = await poolOver(files, STUB_PLUGIN, 1)

    expect(await answersOf(pool, files)).toEqual([
      { kind: "ran" },
      {
        kind: "crashed",
        said:
          "the parser worker extracting it sent an answer that could not be read: Unable to " +
          "deserialize cloned data. Run with --concurrency 1 to extract every file on the main thread.",
      },
      { kind: "ran" },
    ])
    expect(threads.started).toHaveLength(2)
  })
})

describe("a parse pool without its worker script", () => {
  it("refuses to start, naming --concurrency 1", async () => {
    threads.scriptless = true

    await expect(poolOver(["a-ok.stub"], STUB_PLUGIN, 2)).rejects.toThrow(
      /^The worker script that extracts files on parser workers cannot be found from .+\. Run with --concurrency 1 to extract every file on the main thread\.$/,
    )
    expect(threads.attempts).toBe(0)
  })
})

describe("describeWorkerError", () => {
  const stack = new Error("escaped the scan")

  it.each<[string, unknown, string]>([
    [
      "a worker out of memory",
      Object.assign(
        new Error("Worker terminated due to reaching memory limit: JS heap out of memory"),
        {
          code: "ERR_WORKER_OUT_OF_MEMORY",
        },
      ),
      "ran out of memory: Worker terminated due to reaching memory limit: JS heap out of memory",
    ],
    [
      "an Error, by its stack",
      stack,
      `threw outside the scan's own error handling: ${stack.stack}`,
    ],
    ["a thrown null", null, "threw outside the scan's own error handling: null"],
    ["a thrown string", "boom", "threw outside the scan's own error handling: boom"],
  ])("describes %s", (_case, error, said) => {
    expect(describeWorkerError(error)).toBe(said)
  })
})

describe("what a parser worker sends of a file", () => {
  it("leaves out the metadata a clone refuses, and keeps the line it was logged with", () => {
    const sent = portable({
      fileId: 0,
      outcome: { kind: "unroutable" },
      events: [
        {
          kind: "resolver-log",
          plugin: "lang-stub",
          level: "warn",
          message: "tsconfig.json extends ./missing.json",
          meta: { read: () => "{}" },
        },
        { kind: "log", level: "debug", message: "kept whole", meta: { file: "a.stub" } },
      ],
    })

    expect(structuredClone(sent).extraction.events).toEqual([
      {
        kind: "resolver-log",
        plugin: "lang-stub",
        level: "warn",
        message: "tsconfig.json extends ./missing.json",
      },
      { kind: "log", level: "debug", message: "kept whole", meta: { file: "a.stub" } },
    ])
  })
})

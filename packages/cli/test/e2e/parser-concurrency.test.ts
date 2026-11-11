import { cp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { gitTestEnv, useScratchWorkspace } from "@aburi/test-support"
import { afterEach, describe, expect, it } from "vitest"
import {
  DIFF_JSON_FILENAME,
  DIFF_MD_FILENAME,
  EXIT,
  IR_JSON_FILENAME,
  VOCAB_DISCOVERED_FILENAME,
} from "../../src"
import {
  STUB_PLUGIN,
  workerEndingPlugin,
  writeStubRepository,
  writeStubWorkspace,
} from "../stub-language"
import { writeConfig, writeFileAt } from "../workspace"
import { removeWorktreeTempDirs, runBin, useBuiltBin } from "./bin"
import { fixtureRoot } from "./project"

const workspace = useScratchWorkspace("parser-concurrency")

useBuiltBin()

afterEach(async () => {
  await removeWorktreeTempDirs(workspace.root)
})

/** The debug line saying what a scan extracts on, which runs at two counts differ by. */
const SIZING = /^debug: scan: extracting on (.*)\n$/
/** A frame of the trace a debug run prints after its error, naming the calls of a thread. */
const FRAME = /^\s+at /

interface Outcome {
  code: number | null
  stdout: string
  stderr: string[]
  written: Record<string, string>
}

interface Run {
  outcome: Outcome
  /** What each scan of the run says it extracts on. */
  extractedOn: string[]
}

/** A run whose artefacts land in `out`, which it starts without. */
async function ran(argv: readonly string[], read: readonly string[] = []): Promise<Run> {
  const out = join(workspace.root, "out")
  await rm(out, { recursive: true, force: true })
  const run = await runBin(
    workspace.root,
    ["--log-level", "debug", ...argv],
    gitTestEnv(workspace.root),
  )
  const written: Record<string, string> = {}
  for (const name of read) written[name] = await readFile(join(out, name), "utf8")
  const lines = run.stderr.split(/(?<=\n)/)
  return {
    outcome: {
      code: run.code,
      stdout: run.stdout,
      stderr: lines.filter((line) => !SIZING.test(line) && !FRAME.test(line)),
      written,
    },
    extractedOn: lines.flatMap((line) => SIZING.exec(line)?.slice(1) ?? []),
  }
}

function scanned(argv: readonly string[], read: readonly string[] = []): Promise<Run> {
  return ran([...argv, "--output-dir", join(workspace.root, "out")], read)
}

/** What a scan says it extracts on when it starts `workers`, asked as `asked` says. */
function onWorkers(workers: number | string, asked: string): unknown {
  return expect.stringMatching(new RegExp(`^${workers} parser workers \\(${asked}, \\d+ files `))
}

/** The stub language, except that a file named `crash` is extracted holding a function. */
const UNCLONEABLE_PLUGIN = STUB_PLUGIN.replace(
  "      source: {\n",
  `      source: {
        ...(ctx.file.path.includes("crash") ? { reader: () => ctx.file.path } : {}),
`,
)

/** The stub language, except that a file named `astray` files its Symbol above the workspace. */
const ASTRAY_PLUGIN = STUB_PLUGIN.replace(
  "        file: ctx.file.path,\n",
  '        file: ctx.file.path.includes("astray") ? "../" + ctx.file.path : ctx.file.path,\n',
)

const FILES = [
  "a-ok.stub",
  "b-bad.stub",
  "c-boom.stub",
  "d-noisy.stub",
  "e-twin.stub",
  "f-odd.stub",
  "g-notree.stub",
  "h-ok.stub",
  "i-warn.stub",
  "j-ok.stub",
]

describe("aburi scan --concurrency", () => {
  it("writes, prints and logs what one thread does, for every count of workers", async () => {
    await writeStubWorkspace(workspace.root, FILES)
    const argv = ["scan", "--discover", "--no-timestamp", "--format", "json"]
    const read = [IR_JSON_FILENAME, VOCAB_DISCOVERED_FILENAME]
    const alone = await scanned([...argv, "--concurrency", "1"], read)

    expect(alone.outcome.code).toBe(EXIT.GATE)
    expect(alone.outcome.stderr.join("")).toMatch(
      /Skipped c-boom\.stub: extraction threw — plugin exploded/,
    )
    expect(alone.extractedOn).toEqual([])
    for (const [asked, workers] of [
      [2, 2],
      [3, 3],
      [FILES.length + 4, FILES.length],
    ] as const) {
      const run = await scanned([...argv, "--concurrency", String(asked)], read)

      expect(run.outcome).toEqual(alone.outcome)
      expect(run.extractedOn).toEqual([onWorkers(workers, `--concurrency ${asked}`)])
    }
  })

  it("stops at the file a strict scan stops at, saying what one thread says", async () => {
    await writeStubWorkspace(workspace.root, FILES)
    const alone = await scanned(["scan", "--concurrency", "1"])
    const run = await scanned(["scan", "--concurrency", "3"])

    expect(alone.outcome.code).toBe(EXIT.GATE)
    expect(alone.outcome.stderr.join("")).toMatch(/emitted extKind "stub:odd:thing" at f-odd\.stub/)
    expect(run.outcome).toEqual(alone.outcome)
    expect(run.extractedOn).toEqual([onWorkers(3, "--concurrency 3")])
  })

  it.each<[string, string, RegExp]>([
    [
      "a worker exits under",
      workerEndingPlugin("      process.exit(7)"),
      /the parser worker extracting it ended with exit code 7; a plugin may have called process\.exit\(\)/,
    ],
    [
      "a worker throws under, outside the scan's own handling",
      workerEndingPlugin(`      queueMicrotask(() => { throw new Error("escaped the scan") })
      await new Promise(() => {})`),
      /the parser worker extracting it threw outside the scan's own error handling: Error: escaped the scan/,
    ],
    [
      "a worker throws a value that is not an Error under",
      workerEndingPlugin(`      queueMicrotask(() => { throw null })
      await new Promise(() => {})`),
      /the parser worker extracting it threw outside the scan's own error handling: null\. Run with/,
    ],
    [
      "whose extraction a worker cannot send back",
      UNCLONEABLE_PLUGIN,
      /extraction threw — its extraction holds a value that cannot leave the parser worker: .*could not be cloned\. Run with --concurrency 1/,
    ],
  ])("withdraws the one file %s, and extracts the rest", async (_case, plugin, why) => {
    // The second worker is handed d-ok.stub before it reaches b-crash.stub.
    await writeStubWorkspace(workspace.root, [
      "a-ok.stub",
      "b-crash.stub",
      "c-ok.stub",
      "d-ok.stub",
    ])
    await writeFileAt(workspace.root, "lang-stub.mjs", plugin)
    const { outcome } = await scanned(["scan", "--concurrency", "2"], [IR_JSON_FILENAME])
    const ir = JSON.parse(outcome.written[IR_JSON_FILENAME] ?? "") as {
      symbols: { source: { file: string } }[]
      stats: { skippedFiles: { path: string; reason: string }[] }
    }

    expect(outcome.code).toBe(EXIT.GATE)
    expect(outcome.stderr.join("")).toMatch(new RegExp(`Skipped b-crash\\.stub: ${why.source}`))
    expect(ir.symbols.map((symbol) => symbol.source.file)).toEqual([
      "a-ok.stub",
      "c-ok.stub",
      "d-ok.stub",
    ])
    expect(ir.stats.skippedFiles).toEqual([{ path: "b-crash.stub", reason: "extraction-failed" }])
  })

  it("withdraws a file whose Symbol a worker files under no Document path, as one thread does", async () => {
    await writeStubWorkspace(workspace.root, [
      "a-ok.stub",
      "b-astray.stub",
      "c-ok.stub",
      "d-ok.stub",
    ])
    await writeFileAt(workspace.root, "lang-stub.mjs", ASTRAY_PLUGIN)
    const alone = await scanned(["scan", "--concurrency", "1"], [IR_JSON_FILENAME])
    const run = await scanned(["scan", "--concurrency", "2"], [IR_JSON_FILENAME])

    expect(alone.outcome.code).toBe(EXIT.GATE)
    expect(alone.outcome.stderr.join("")).toMatch(
      /Skipped b-astray\.stub: lang-stub's SymbolCandidate\.source\.file /,
    )
    expect(run.outcome).toEqual(alone.outcome)
    expect(run.extractedOn).toEqual([onWorkers(2, "--concurrency 2")])
  })

  it("ends the run once workers have ended under three files, naming them", async () => {
    const files = ["a-crash.stub", "b-crash.stub", "c-ok.stub", "d-crash.stub", "e-ok.stub"]
    await writeStubWorkspace(workspace.root, files)
    await writeFileAt(workspace.root, "lang-stub.mjs", workerEndingPlugin("      process.exit(7)"))
    const { outcome } = await scanned(["scan", "--concurrency", "2"])

    const ended =
      /^Parser workers ended 3 times \((.*)\), so the plugins, not one file, are ending them\. Run with --concurrency 1/.exec(
        outcome.stderr.at(-1) ?? "",
      )

    expect(outcome.code).toBe(EXIT.RUNTIME)
    // Which worker ends first is the scheduler's to decide.
    expect(ended?.[1]?.split("; ").sort()).toEqual(
      ["a-crash.stub", "b-crash.stub", "d-crash.stub"].map((file) => `extracting ${file}`),
    )
  })

  it.each<[string, string, RegExp]>([
    [
      "throws",
      'throw new Error("this plugin keeps to the main thread")',
      /A parser worker failed: .*this plugin keeps to the main thread[\s\S]*Run with --concurrency 1/,
    ],
    [
      "exits",
      "process.exit(5)",
      /A parser worker ended with exit code 5; a plugin may have called process\.exit\(\) before it had loaded the scan's plugins\.\nRun with --concurrency 1/,
    ],
  ])(
    "ends the run when a worker %s as it loads the plugins the scan loaded",
    async (_how, end, said) => {
      await writeStubWorkspace(workspace.root, ["a-ok.stub", "b-ok.stub"])
      await writeFileAt(
        workspace.root,
        "lang-stub.mjs",
        `import { isMainThread } from "node:worker_threads"
if (!isMainThread) ${end}
${STUB_PLUGIN}`,
      )
      const { outcome } = await scanned(["scan", "--concurrency", "2"])

      expect(outcome.code).toBe(EXIT.RUNTIME)
      expect(outcome.stderr.join("")).toMatch(said)
    },
  )

  it.each(["0", "-1", "1.5", "two", "99999999999999999999"])(
    "refuses --concurrency %s before it scans",
    async (value) => {
      await writeStubWorkspace(workspace.root, ["a-ok.stub"])
      const { outcome } = await scanned(["scan", "--concurrency", value])

      expect(outcome.code).toBe(EXIT.INPUT_ERROR)
      expect(outcome.stderr.join("")).toContain(
        `--concurrency must be a positive integer (got "${value}")`,
      )
    },
  )
})

describe("aburi scan --concurrency, with the language, framework and effects plugins", () => {
  // Free memory may leave room for two of the three workers a language this hungry asks for.
  const PLUGINS_WORKERS = "[23]"

  it.each<[string, Record<string, unknown> | null]>([
    [
      "nestjs-billing",
      {
        languages: ["lang-typescript"],
        frameworks: ["framework-nestjs"],
        effects: ["effects-nest"],
      },
    ],
    ["effects-coverage", null],
  ])("writes the IR one thread writes over %s", async (project, config) => {
    await cp(fixtureRoot(project), workspace.root, { recursive: true })
    if (config !== null) await writeConfig(workspace.root, config)
    const alone = await scanned(["scan", "--concurrency", "1"], [IR_JSON_FILENAME])
    const run = await scanned(["scan", "--concurrency", "3"], [IR_JSON_FILENAME])

    expect(alone.outcome.code).toBe(EXIT.SUCCESS)
    expect(run.outcome).toEqual(alone.outcome)
    expect(run.extractedOn).toEqual([onWorkers(PLUGINS_WORKERS, "--concurrency 3")])
  })

  it("records the calls an effects plugin declines in the files each worker extracts", async () => {
    await cp(fixtureRoot("effects-coverage"), workspace.root, { recursive: true })
    for (const [file, call] of [
      ["src/reports/revenue.ts", "prisma.$queryRaw`SELECT sum(amount_cents) FROM orders`"],
      ["src/reports/vacuum.ts", 'prisma.$executeRawUnsafe("VACUUM orders")'],
    ] as const) {
      await writeFileAt(
        workspace.root,
        file,
        `import { PrismaClient } from "@prisma/client"\n\nexport async function run(prisma: PrismaClient) {\n  return await ${call}\n}\n`,
      )
    }
    const alone = await scanned(["scan", "--concurrency", "1"], [IR_JSON_FILENAME])
    const run = await scanned(["scan", "--concurrency", "3"], [IR_JSON_FILENAME])
    const ir = JSON.parse(alone.outcome.written[IR_JSON_FILENAME] ?? "") as {
      stats: { declinedCalls?: { symbolId: string }[] }
    }

    expect(alone.outcome.code).toBe(EXIT.SUCCESS)
    expect(ir.stats.declinedCalls?.map((call) => call.symbolId)).toEqual([
      "ts:src/reports/revenue.ts#run",
      "ts:src/reports/vacuum.ts#run",
    ])
    expect(run.outcome).toEqual(alone.outcome)
    expect(run.extractedOn).toEqual([onWorkers(PLUGINS_WORKERS, "--concurrency 3")])
  })
})

describe("aburi diff --concurrency", () => {
  it.each<[string, string]>([
    ["--parallel-scans", "--concurrency 2, shared by 2 scans"],
    ["--no-parallel-scans", "--concurrency 2"],
  ])(
    "reports with %s what it reports with every file extracted on the main thread",
    async (together, asked) => {
      await writeStubRepository(workspace.root, {
        base: ["a-ok.stub", "b-bad.stub", "c-ok.stub", "d-warn.stub"],
        head: ["a-ok.stub", "c-ok.stub", "d-warn.stub", "e-boom.stub", "f-ok.stub"],
      })
      const argv = ["diff", "main..HEAD", "--format", "both", together]
      const read = [DIFF_JSON_FILENAME, DIFF_MD_FILENAME]
      const alone = await scanned([...argv, "--concurrency", "1"], read)
      const run = await scanned([...argv, "--concurrency", "2"], read)

      expect(alone.outcome.code).toBe(EXIT.GATE)
      expect(run.outcome).toEqual(alone.outcome)
      expect(run.extractedOn).toEqual([onWorkers(2, asked), onWorkers(2, asked)])
    },
  )
})

describe("aburi explain --concurrency", () => {
  it("answers from the scan it runs as one thread does", async () => {
    await writeStubWorkspace(workspace.root, ["a-ok.stub", "b-ok.stub", "c-ok.stub"], {
      output: { dir: "out" },
    })
    const alone = await ran(["explain", "b_ok_stub", "--concurrency", "1"])
    const run = await ran(["explain", "b_ok_stub", "--concurrency", "2"])

    expect(alone.outcome.code).toBe(EXIT.SUCCESS)
    expect(alone.outcome.stdout).toContain("b_ok_stub")
    expect(run.outcome).toEqual(alone.outcome)
    expect(run.extractedOn).toEqual([onWorkers(2, "--concurrency 2")])
  })
})

import { mkdir, readFile } from "node:fs/promises"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, type ExitCode, runCli, VOCAB_DISCOVERED_FILENAME } from "../src"
import { documentWith, symbolFor } from "./ir-documents"
import {
  DIM,
  ERASE,
  RED,
  runCliIn,
  screenOf,
  TerminalStream,
  withoutColor,
  YELLOW,
} from "./run-cli"
import { writeStubRepository, writeStubWorkspace } from "./stub-language"
import { defaultOutput, writeConfig, writeFileAt, writeIRs, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("terminal-output")

const WARNING = "⚠ 1 file(s) had recoverable parse errors."
const YELLOW_WARNING = YELLOW(WARNING)
const PROGRESS_TEXT = /discovering files…|extracting \d+\/\d+ files|resolving calls…|comparing…/

/** The same run twice: once with stderr piped, once with stderr on a terminal. */
async function pipedAndOnTerminal(argv: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const piped = await runCliIn(workspace.root, argv, env)
  const terminal = await runCliIn(workspace.root, argv, env, new TerminalStream())
  return { piped, terminal }
}

describe("stderr on a terminal", () => {
  it("draws the scan's progress, writes each line above it, and leaves only those lines behind", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub", "warn.stub"])

    const { piped, terminal } = await pipedAndOnTerminal(["scan", "--format", "json"])

    expect(terminal.code).toBe(piped.code)
    expect(terminal.stdout).toBe(piped.stdout)
    for (const phase of [
      "discovering files…",
      "extracting 0/2 files",
      "extracting 2/2 files",
      "resolving calls…",
    ]) {
      expect(terminal.stderr).toContain(`${ERASE}${phase}`)
    }
    expect(terminal.stderr).toContain(`${ERASE}${YELLOW_WARNING}\n`)
    expect(terminal.stderr.endsWith(ERASE)).toBe(true)
    expect(screenOf(withoutColor(terminal.stderr))).toBe(piped.stderr)
    expect(piped.stderr).toContain(WARNING)
  })

  it("draws the progress of the rescan aburi explain runs, and erases it before the answer", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])

    const { piped, terminal } = await pipedAndOnTerminal([
      "explain",
      "ok_stub",
      "--debug-resolution",
    ])

    expect(terminal.code).toBe(EXIT.SUCCESS)
    expect(terminal.stdout).toBe(piped.stdout)
    expect(terminal.stderr).toContain(`${ERASE}extracting 1/1 files`)
    expect(screenOf(terminal.stderr)).toBe(piped.stderr)
  })

  it.each(["--parallel-scans", "--no-parallel-scans"])(
    "names the side of each scan aburi diff runs under %s, then the comparison",
    async (flag) => {
      await writeStubRepository(workspace.root, {
        base: ["ok.stub"],
        head: ["ok.stub", "added.stub"],
      })

      const { piped, terminal } = await pipedAndOnTerminal(["diff", "main..HEAD", flag])

      expect(terminal.code).toBe(EXIT.SUCCESS)
      expect(terminal.stdout).toBe(piped.stdout)
      expect(terminal.stderr).toContain(`${ERASE}base: discovering files…`)
      expect(terminal.stderr).toMatch(/head: extracting 2\/2 files/)
      expect(terminal.stderr).toContain(`${ERASE}comparing…`)
      // Whether two scans at once overlap on the line is the scheduler's to decide; in turn, never.
      if (flag === "--no-parallel-scans") expect(terminal.stderr).not.toContain(" · ")
      expect(screenOf(terminal.stderr)).toBe(piped.stderr)
    },
  )

  it("leaves none of the line on a screen that stdout and stderr share", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub", "warn.stub"])
    const screen = new TerminalStream()

    const code = await runCli({
      argv: ["scan", "--format", "json"],
      cwd: workspace.root,
      stdout: screen,
      stderr: screen,
      env: {},
    })

    expect(code).toBe(EXIT.SUCCESS)
    expect(screen.text()).toMatch(PROGRESS_TEXT)
    const left = screenOf(withoutColor(screen.text()))
    expect(left).toContain(`${WARNING}\n`)
    expect(left).toMatch(/^\d+ kept · /m)
    expect(left).not.toMatch(PROGRESS_TEXT)
  })

  it("erases the line before an error that ends the run, leaving what a pipe gets", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])
    await mkdir(defaultOutput(workspace.root, "aburi.ir.json"), { recursive: true })

    const { piped, terminal } = await pipedAndOnTerminal(["scan", "--format", "json"])

    expect(terminal.code).toBe(EXIT.INPUT_ERROR)
    expect(piped.code).toBe(EXIT.INPUT_ERROR)
    expect(terminal.stderr).toContain(`${ERASE}resolving calls…`)
    expect(screenOf(withoutColor(terminal.stderr))).toBe(piped.stderr)
    expect(terminal.stderr.trimEnd().endsWith(RED(piped.stderr.trimEnd()))).toBe(true)
  })

  it("shows the comparison alone when aburi diff reads two IRs", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])
    expect((await runCliIn(workspace.root, ["scan", "--format", "json"])).code).toBe(EXIT.SUCCESS)
    const ir = defaultOutput(workspace.root, "aburi.ir.json")

    const { terminal } = await pipedAndOnTerminal(["diff", "--base", ir, "--head", ir])

    expect(terminal.stderr).toBe(`${ERASE}comparing…${ERASE}`)
  })
})

describe("colour", () => {
  it.each<[string, readonly string[], NodeJS.ProcessEnv, boolean]>([
    ["nothing set", ["scan"], {}, true],
    ["NO_COLOR", ["scan"], { NO_COLOR: "1" }, false],
    ["FORCE_COLOR over NO_COLOR", ["scan"], { NO_COLOR: "1", FORCE_COLOR: "1" }, true],
    ["FORCE_COLOR=0", ["scan"], { FORCE_COLOR: "0" }, false],
    ["--no-color over FORCE_COLOR", ["scan", "--no-color"], { FORCE_COLOR: "1" }, false],
    ["--no-color before the command", ["--no-color", "scan"], {}, false],
  ])(
    "follows %s on a terminal, the progress line drawn either way",
    async (_, argv, env, coloured) => {
      await writeStubWorkspace(workspace.root, ["warn.stub"])

      const { stderr } = await runCliIn(workspace.root, argv, env, new TerminalStream())

      expect(stderr.includes(YELLOW_WARNING)).toBe(coloured)
      expect(stderr).toContain(WARNING)
      expect(stderr).toContain(`${ERASE}discovering files…`)
    },
  )

  it("colours piped stderr under FORCE_COLOR, the same text once the colour is stripped", async () => {
    await writeStubWorkspace(workspace.root, ["warn.stub"])

    const plain = await runCliIn(workspace.root, ["scan"])
    const forced = await runCliIn(workspace.root, ["scan"], { FORCE_COLOR: "1" })

    expect(withoutColor(plain.stderr)).toBe(plain.stderr)
    expect(plain.stderr).not.toContain(ERASE)
    expect(forced.stderr).toContain(YELLOW_WARNING)
    expect(forced.stderr).not.toContain(ERASE)
    expect(withoutColor(forced.stderr)).toBe(plain.stderr)
    expect(forced.stdout).toBe(plain.stdout)
  })

  it("colours warnings yellow and the log of either side's scan dim, the text unchanged", async () => {
    await writeStubRepository(workspace.root, {
      base: ["ok.stub", "warn.stub"],
      head: ["ok.stub", "warn.stub", "added.stub"],
    })
    const argv = ["diff", "main..HEAD", "--parallel-scans", "--log-level", "debug"]

    const plain = await runCliIn(workspace.root, argv)
    const forced = await runCliIn(workspace.root, argv, { FORCE_COLOR: "1" })

    const lines = forced.stderr.trimEnd().split("\n")
    const isDebug = (line: string) => withoutColor(line).startsWith("debug: ")
    // The base scan, on its worker, is through before the head's held log is let out.
    const baseEnds = lines.findIndex((line) => withoutColor(line).startsWith("⚠ base ref"))
    expect(lines.slice(0, baseEnds).filter(isDebug)).not.toEqual([])
    expect(lines.slice(baseEnds).filter(isDebug)).not.toEqual([])
    for (const line of lines.filter(isDebug)) expect(line).toBe(DIM(withoutColor(line)))
    for (const line of lines.filter((line) => withoutColor(line).startsWith("⚠ "))) {
      expect(line).toBe(YELLOW(withoutColor(line)))
    }
    expect(withoutColor(forced.stderr)).toBe(plain.stderr)
  })

  it("leaves an argument error before --no-color plain", async () => {
    const { stderr } = await runCliIn(
      workspace.root,
      ["--log-level", "bogus", "--no-color", "scan"],
      {},
      new TerminalStream(),
    )

    expect(stderr).toContain("error: option '--log-level <level>' argument 'bogus'")
    expect(withoutColor(stderr)).toBe(stderr)
  })

  it("colours an error that ends the run red", async () => {
    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "bogus"], {
      FORCE_COLOR: "1",
    })

    expect(code).toBe(EXIT.INPUT_ERROR)
    const [message = ""] = stderr.split("\n")
    expect(message).toBe(RED(withoutColor(message)))
    expect(message).toContain("error: option '--format <format>' argument 'bogus'")
  })

  it("colours aburi vocab's warning yellow and its line for a value nothing owns red", async () => {
    const { code, stderr } = await runCliIn(workspace.root, ["vocab", "who-owns", "nope"], {
      FORCE_COLOR: "1",
    })

    expect(code).toBe(EXIT.RUNTIME)
    const [warning = "", error = ""] = stderr.trimEnd().split("\n")
    expect(warning).toBe(YELLOW(withoutColor(warning)))
    expect(withoutColor(warning)).toMatch(/^⚠ No aburi\.json or aburi\.jsonc was found/)
    expect(error).toBe(RED(withoutColor(error)))
    expect(withoutColor(error)).toMatch(/^No owner for "nope"/)
  })

  it("colours each line of a gate that trips red", async () => {
    const gone = symbolFor("ts:src/gone.ts#gone")
    const paths = await writeIRs(
      workspace.root,
      documentWith({ symbols: [gone] }),
      documentWith({ symbols: [] }),
    )

    const { code, stderr } = await runCliIn(
      workspace.root,
      ["diff", "--base", paths.base, "--head", paths.head, "--fail-on", "removed"],
      { FORCE_COLOR: "1" },
    )

    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain(
      `${RED("--fail-on removed tripped (observed: 1 removed)")}\n${RED("  ts:src/gone.ts#gone")}\n`,
    )
  })
})

describe("CI mode", () => {
  it.each<[string, readonly string[], NodeJS.ProcessEnv]>([
    ["CI=true", ["scan"], { CI: "true" }],
    ["--ci after the command", ["scan", "--ci"], {}],
    ["--ci before it", ["--ci", "scan"], {}],
    ["TERM=dumb, which is no CI but takes neither", ["scan"], { TERM: "dumb" }],
  ])("draws no progress line and no colour under %s", async (_, argv, env) => {
    await writeStubWorkspace(workspace.root, ["ok.stub", "warn.stub"])

    const piped = await runCliIn(workspace.root, argv, env)
    const terminal = await runCliIn(workspace.root, argv, env, new TerminalStream())

    expect(terminal.stderr).toBe(piped.stderr)
    expect(terminal.stderr).toContain(WARNING)
    expect(terminal.stdout).toBe(piped.stdout)
    expect(terminal.code).toBe(piped.code)
  })

  it("colours under FORCE_COLOR still, with no progress line", async () => {
    await writeStubWorkspace(workspace.root, ["warn.stub"])

    const { stderr } = await runCliIn(
      workspace.root,
      ["scan", "--ci"],
      { FORCE_COLOR: "1" },
      new TerminalStream(),
    )

    expect(stderr).toContain(YELLOW_WARNING)
    expect(stderr).not.toContain(ERASE)
  })

  it("leaves the timestamp out of the discovered-vocabulary record under --ci", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])

    expect((await runCliIn(workspace.root, ["scan", "--discover", "--ci"])).code).toBe(EXIT.SUCCESS)

    const record = JSON.parse(
      await readFile(defaultOutput(workspace.root, VOCAB_DISCOVERED_FILENAME), "utf8"),
    ) as Record<string, unknown>
    expect(record).toEqual({ items: [] })
  })
})

describe("stack traces", () => {
  async function writeExplodingPlugin(
    module = 'throw new Error("module exploded")\n',
  ): Promise<void> {
    await writePackageJson(workspace.root)
    await writeConfig(workspace.root, { languages: ["./exploding.mjs"] })
    await writeFileAt(workspace.root, "exploding.mjs", module)
  }

  it("follows an error that ends the run at exit 3 with its stack and its cause's at debug", async () => {
    await writeExplodingPlugin()

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--log-level", "debug"])

    expect(code).toBe(EXIT.GATE)
    const lines = stderr.trimEnd().split("\n")
    expect(lines[0]).toMatch(/^Failed to import plugin "\.\/exploding\.mjs" .*: module exploded$/)
    expect(lines[1]).toMatch(/^\s+at /)
    const cause = lines.indexOf("caused by: Error: module exploded")
    expect(cause).toBeGreaterThan(1)
    expect(lines[cause + 1]).toMatch(/^\s+at .*exploding\.mjs/)
  })

  it("dims the trace under FORCE_COLOR, and the message stays red", async () => {
    await writeExplodingPlugin()

    const { stderr } = await runCliIn(workspace.root, ["scan", "--log-level", "debug"], {
      FORCE_COLOR: "1",
    })

    const [message, ...trace] = stderr.trimEnd().split("\n")
    expect(message).toBe(RED(withoutColor(message ?? "")))
    expect(trace.length).toBeGreaterThan(1)
    for (const line of trace) expect(line).toBe(DIM(withoutColor(line)))
  })

  it.each<[string, string, string[]]>([
    [
      "a cause that is not an Error, by its value",
      'throw new Error("module exploded", { cause: "the grammar was never built" })\n',
      ["caused by: Error: module exploded", "caused by: the grammar was never built"],
    ],
    [
      "a cycle of causes, each once",
      [
        'const first = new Error("first")',
        'const second = new Error("second", { cause: first })',
        "first.cause = second",
        "throw first",
        "",
      ].join("\n"),
      ["caused by: Error: first", "caused by: Error: second"],
    ],
  ])("names %s", async (_, module, causes) => {
    await writeExplodingPlugin(module)

    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--log-level", "debug"])

    expect(code).toBe(EXIT.GATE)
    expect(stderr.split("\n").filter((line) => line.startsWith("caused by: "))).toEqual(causes)
  })

  it.each<[string, readonly string[], ExitCode]>([
    ["at the default level", ["scan"], EXIT.GATE],
    [
      "for an exit-2 error at debug",
      ["explain", "anything", "--ir", "missing.json", "--log-level", "debug"],
      EXIT.INPUT_ERROR,
    ],
  ])("writes the message alone %s", async (_, argv, exitCode) => {
    await writeExplodingPlugin()

    const { code, stderr } = await runCliIn(workspace.root, argv)

    expect(code).toBe(exitCode)
    expect(stderr.trimEnd().split("\n")).toHaveLength(1)
    expect(stderr).not.toMatch(/^\s+at /m)
  })
})

describe("the global options", () => {
  it.each(["init", "scan", "diff", "explain"])(
    "lists --no-color and --ci in `aburi %s --help`",
    async (command) => {
      const { stdout } = await runCliIn(workspace.root, [command, "--help"])

      expect(stdout).toMatch(/Global Options:\n[\s\S]*--no-color[\s\S]*--ci/)
    },
  )

  it("writes no progress line for aburi init, whatever the terminal", async () => {
    await writePackageJson(workspace.root)
    const stderr = new TerminalStream()

    await runCliIn(workspace.root, ["init"], {}, stderr)

    expect(stderr.text()).not.toContain(ERASE)
  })
})

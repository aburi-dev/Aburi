import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createTerminal,
  PROGRESS_INTERVAL_MS,
  type Terminal,
  type TerminalMode,
  type TerminalSettings,
  terminalMode,
} from "../src/terminal"
import { DIM, ERASE, MemStream, RED, TerminalStream, YELLOW } from "./run-cli"

const PLAIN_TERMINAL: TerminalSettings = {
  env: { noColor: false, forceColor: null, dumbTerminal: false },
  ci: false,
  colorOption: true,
  isTerminal: true,
}

function settings(overrides: {
  env?: Partial<TerminalSettings["env"]>
  ci?: boolean
  colorOption?: boolean
  isTerminal?: boolean
}): TerminalSettings {
  return { ...PLAIN_TERMINAL, ...overrides, env: { ...PLAIN_TERMINAL.env, ...overrides.env } }
}

describe("terminalMode", () => {
  it.each<[string, Parameters<typeof settings>[0], TerminalMode]>([
    ["colours and draws progress on a terminal", {}, { color: true, progress: true }],
    ["does neither off one", { isTerminal: false }, { color: false, progress: false }],
    [
      "does neither on TERM=dumb",
      { env: { dumbTerminal: true } },
      { color: false, progress: false },
    ],
    [
      "drops colour alone under NO_COLOR",
      { env: { noColor: true } },
      { color: false, progress: true },
    ],
    ["does neither in CI mode", { ci: true }, { color: false, progress: false }],
    [
      "colours off a terminal under FORCE_COLOR, with no progress line",
      { isTerminal: false, env: { forceColor: true } },
      { color: true, progress: false },
    ],
    [
      "lets FORCE_COLOR win over NO_COLOR",
      { env: { forceColor: true, noColor: true } },
      { color: true, progress: true },
    ],
    [
      "lets FORCE_COLOR win over CI mode, and still draws no progress line there",
      { ci: true, env: { forceColor: true } },
      { color: true, progress: false },
    ],
    [
      "lets FORCE_COLOR colour TERM=dumb, which still draws no progress line",
      { env: { dumbTerminal: true, forceColor: true } },
      { color: true, progress: false },
    ],
    [
      "lets FORCE_COLOR=0 turn colour off on a terminal",
      { env: { forceColor: false } },
      { color: false, progress: true },
    ],
    [
      "lets --no-color win over FORCE_COLOR, and leaves the progress line",
      { colorOption: false, env: { forceColor: true } },
      { color: false, progress: true },
    ],
  ])("%s", (_, overrides, expected) => {
    expect(terminalMode(settings(overrides))).toEqual(expected)
  })
})

const made: Terminal[] = []

afterEach(() => {
  // A line left drawn would keep its fatal-signal listeners on the test process.
  for (const terminal of made.splice(0)) terminal.endProgress()
  vi.useRealTimers()
})

/** A terminal on `stream` whose clock reads `clock.now`. */
function terminalOn(stream: MemStream, mode: TerminalMode) {
  const clock = { now: 0 }
  const terminal = createTerminal(stream, { mode: () => mode, now: () => clock.now })
  made.push(terminal)
  return { terminal, clock, written: () => stream.chunks }
}

const ON: TerminalMode = { color: true, progress: true }
const OFF: TerminalMode = { color: false, progress: false }
const PROGRESS_WITHOUT_COLOR: TerminalMode = { color: false, progress: true }

describe("createTerminal — lines", () => {
  it("colours each line of a message in its tone, leaving an empty one bare", () => {
    const { terminal, written } = terminalOn(new TerminalStream(), ON)

    terminal.say("⚠ two\n\n  lines", "warning")
    terminal.say("failed", "error")
    terminal.say("debug: a", "muted")
    terminal.say("plain")

    expect(written()).toEqual([
      `${YELLOW("⚠ two")}\n\n${YELLOW("  lines")}\n`,
      `${RED("failed")}\n`,
      `${DIM("debug: a")}\n`,
      "plain\n",
    ])
  })

  it("writes the same text without colour", () => {
    const { terminal, written } = terminalOn(new MemStream(), OFF)

    terminal.say("⚠ warned", "warning")

    expect(written()).toEqual(["⚠ warned\n"])
  })
})

describe("createTerminal — the progress line", () => {
  it("draws nothing when the mode has no progress line", () => {
    const { terminal, written } = terminalOn(new MemStream(), OFF)

    terminal.progress("extracting 1/2 files", true)
    terminal.endProgress()

    expect(written()).toEqual([])
  })

  it("redraws in place, at most once an interval unless told to at once", () => {
    const { terminal, clock, written } = terminalOn(new TerminalStream(), ON)

    terminal.progress("extracting 0/3 files", true)
    clock.now = PROGRESS_INTERVAL_MS - 1
    terminal.progress("extracting 1/3 files")
    clock.now = PROGRESS_INTERVAL_MS
    terminal.progress("extracting 2/3 files")
    clock.now += 1
    terminal.progress("resolving calls…", true)

    expect(written()).toEqual([
      `${ERASE}extracting 0/3 files`,
      `${ERASE}extracting 2/3 files`,
      `${ERASE}resolving calls…`,
    ])
  })

  it("writes a line above it and draws it again, with the latest text it was given", () => {
    const { terminal, written } = terminalOn(new TerminalStream(), PROGRESS_WITHOUT_COLOR)

    terminal.progress("extracting 0/3 files", true)
    terminal.progress("extracting 1/3 files")
    terminal.say("⚠ warned", "warning")

    expect(written()).toEqual([
      `${ERASE}extracting 0/3 files`,
      `${ERASE}⚠ warned\n${ERASE}extracting 1/3 files`,
    ])
  })

  it("erases it once for good, and writes plain lines after that", () => {
    const { terminal, written } = terminalOn(new TerminalStream(), PROGRESS_WITHOUT_COLOR)

    terminal.progress("resolving calls…", true)
    terminal.endProgress()
    terminal.endProgress()
    terminal.say("done")

    expect(written()).toEqual([`${ERASE}resolving calls…`, ERASE, "done\n"])
  })

  it("draws a held count once the interval is up, with nothing newer to draw it", () => {
    vi.useFakeTimers()
    const { terminal, clock, written } = terminalOn(new TerminalStream(), PROGRESS_WITHOUT_COLOR)

    terminal.progress("extracting 100/5002 files", true)
    clock.now = 40
    terminal.progress("extracting 150/5002 files")
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS - 41)
    const beforeTheInterval = [...written()]
    clock.now = PROGRESS_INTERVAL_MS
    vi.advanceTimersByTime(1)

    expect(beforeTheInterval).toEqual([`${ERASE}extracting 100/5002 files`])
    expect(written()).toEqual([
      `${ERASE}extracting 100/5002 files`,
      `${ERASE}extracting 150/5002 files`,
    ])
  })

  it("draws nothing it held once the line is erased for good", () => {
    vi.useFakeTimers()
    const { terminal, written } = terminalOn(new TerminalStream(), PROGRESS_WITHOUT_COLOR)

    terminal.progress("extracting 1/3 files", true)
    terminal.progress("extracting 2/3 files")
    terminal.endProgress()
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS)

    expect(written()).toEqual([`${ERASE}extracting 1/3 files`, ERASE])
  })

  it("cuts a line as wide as the terminal or wider one column short of it", () => {
    const { terminal, written } = terminalOn(new TerminalStream(12), PROGRESS_WITHOUT_COLOR)

    terminal.progress("extracting 412/5002 files", true)
    terminal.progress("short", true)
    terminal.progress("elevenchars", true)
    terminal.progress("twelve chars", true)

    expect(written()).toEqual([
      `${ERASE}extracting…`,
      `${ERASE}short`,
      `${ERASE}elevenchars`,
      `${ERASE}twelve cha…`,
    ])
  })
})

describe("createTerminal — a fatal signal", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "erases the line on %s before any other listener writes",
    (signal) => {
      const stream = new TerminalStream()
      const { terminal } = terminalOn(stream, PROGRESS_WITHOUT_COLOR)
      const seenByTheOther: string[] = []
      // Another listener keeps the signal from being raised again, which would end the test run.
      const other = () => seenByTheOther.push(stream.text())
      process.on(signal, other)
      try {
        terminal.progress("extracting 1/3 files", true)

        process.emit(signal)
      } finally {
        process.off(signal, other)
      }

      expect(seenByTheOther).toEqual([`${ERASE}extracting 1/3 files${ERASE}`])
    },
  )

  it("listens only while a line is drawn", () => {
    const before = process.listenerCount("SIGINT")
    const { terminal } = terminalOn(new TerminalStream(), PROGRESS_WITHOUT_COLOR)

    terminal.say("before any line")
    const undrawn = process.listenerCount("SIGINT")
    terminal.progress("resolving calls…", true)
    const drawn = process.listenerCount("SIGINT")
    terminal.endProgress()

    expect([undrawn, drawn, process.listenerCount("SIGINT")]).toEqual([before, before + 1, before])
  })
})

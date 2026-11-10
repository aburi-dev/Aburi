import { writeSync } from "node:fs"
import type { AburiEnv, LogLevel } from "./env"
import { cleanUpOnFatalSignal } from "./signal-cleanup"

export type Tone = "warning" | "error" | "muted"

export interface TerminalMode {
  readonly color: boolean
  readonly progress: boolean
}

export interface TerminalSettings {
  env: Pick<AburiEnv, "noColor" | "forceColor" | "dumbTerminal">
  /** CI mode, from the `CI` env or `--ci`. */
  ci: boolean
  /** The `color` option, false under `--no-color`. */
  colorOption: boolean
  /** Whether the stream is a terminal (`isTTY`). */
  isTerminal: boolean
}

export function terminalMode(settings: TerminalSettings): TerminalMode {
  const terminal = settings.isTerminal && !settings.env.dumbTerminal
  return { color: colorOn(settings, terminal), progress: terminal && !settings.ci }
}

function colorOn(settings: TerminalSettings, terminal: boolean): boolean {
  if (!settings.colorOption) return false
  if (settings.env.forceColor !== null) return settings.env.forceColor
  if (settings.env.noColor || settings.ci) return false
  return terminal
}

export function toneOfLevel(level: LogLevel): Tone {
  switch (level) {
    case "debug":
    case "info":
      return "muted"
    case "warn":
      return "warning"
    case "error":
      return "error"
  }
}

const SGR: Record<Tone, readonly [open: string, close: string]> = {
  warning: ["\u001b[33m", "\u001b[39m"],
  error: ["\u001b[31m", "\u001b[39m"],
  muted: ["\u001b[2m", "\u001b[22m"],
}

const ERASE_LINE = "\r\u001b[2K"

export const PROGRESS_INTERVAL_MS = 100

/** stderr as a run writes it: lines, coloured or not, above a progress line that may be drawn. */
export interface Terminal {
  /** `text`, one or more lines without the final newline, each in `tone`. */
  say(text: string, tone?: Tone): void
  /**
   * Shows `text` as the progress line. Within the redraw interval of the last draw it is held, and
   * drawn when the interval is up unless newer text takes its place; `urgent` draws it at once.
   */
  progress(text: string, urgent?: boolean): void
  /** Erases the progress line; the next `progress` draws a new one. */
  endProgress(): void
}

export interface TerminalOptions {
  /** Read on every write, so that it can depend on options parsed after the terminal is made. */
  mode: () => TerminalMode
  now?: () => number
}

export function createTerminal(stream: NodeJS.WritableStream, options: TerminalOptions): Terminal {
  const now = options.now ?? (() => performance.now())
  let latest: string | null = null
  let drawn = false
  let drawnAt = Number.NEGATIVE_INFINITY
  let held: NodeJS.Timeout | null = null
  let releaseSignals: (() => void) | null = null

  const fitted = (text: string): string => {
    const columns = (stream as { columns?: unknown }).columns
    // One column short: a line that fills the last one wraps on some terminals.
    if (typeof columns !== "number" || columns < 2) return text
    const characters = Array.from(text)
    if (characters.length < columns) return text
    return `${characters.slice(0, columns - 2).join("")}…`
  }
  // Synchronous: the process ends on the signal before an asynchronous write would reach the screen.
  const eraseAtOnce = (): void => {
    const fd = (stream as { fd?: unknown }).fd
    if (typeof fd === "number") writeSync(fd, ERASE_LINE)
    else stream.write(ERASE_LINE)
  }
  const cancelHeld = (): void => {
    if (held !== null) clearTimeout(held)
    held = null
  }
  const redraw = (): string => {
    cancelHeld()
    if (latest === null) return ""
    // First among the signal's listeners, so that whatever another one says starts a line of its own.
    releaseSignals ??= cleanUpOnFatalSignal(eraseAtOnce, undefined, { first: true })
    drawn = true
    drawnAt = now()
    return `${ERASE_LINE}${fitted(latest)}`
  }

  return {
    say(text, tone) {
      const color = options.mode().color
      const lines = text
        .split("\n")
        .map((line) => (color && tone !== undefined ? painted(line, tone) : line))
        .join("\n")
      stream.write(drawn ? `${ERASE_LINE}${lines}\n${redraw()}` : `${lines}\n`)
    },
    progress(text, urgent = false) {
      if (!options.mode().progress) return
      latest = text
      const wait = drawn && !urgent ? drawnAt + PROGRESS_INTERVAL_MS - now() : 0
      if (wait <= 0) stream.write(redraw())
      else held ??= setTimeout(() => stream.write(redraw()), wait).unref()
    },
    endProgress() {
      cancelHeld()
      releaseSignals?.()
      releaseSignals = null
      if (drawn) stream.write(ERASE_LINE)
      drawn = false
      latest = null
    },
  }
}

function painted(line: string, tone: Tone): string {
  if (line.length === 0) return line
  const [open, close] = SGR[tone]
  return `${open}${line}${close}`
}

#!/usr/bin/env node
import { rmSync } from "node:fs"
import { createRequire } from "node:module"
import { constants } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { createAburiServer } from "../server"

const USAGE = `Usage: aburi-mcp [--cwd <path>] [--config <path>]

Answers an AI agent's questions about a workspace over MCP on stdio, from runs of the aburi CLI.

Options:
  --cwd <path>     the directory whose workspace it answers about (default: the current one)
  --config <path>  the config file every run reads, as aburi's --config does
  -v, --version    output the version number
  -h, --help       display help
`

const SIGNALS = ["SIGINT", "SIGTERM"] as const

function main(): void {
  let parsed: ReturnType<typeof parseOptions>
  try {
    parsed = parseOptions()
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  const { version } = createRequire(import.meta.url)("@aburi/mcp/package.json") as {
    version: string
  }
  if (parsed.help === true) {
    process.stdout.write(USAGE)
    return
  }
  if (parsed.version === true) {
    process.stdout.write(`${version}\n`)
    return
  }

  const aburi = createAburiServer({
    cwd: resolve(parsed.cwd ?? "."),
    ...(parsed.config === undefined ? {} : { configPath: resolve(parsed.config) }),
    version,
  })
  const connection = serveStdio(aburi.server, {
    onerror: (error) => say(error.message),
  })
  const removeDirectory = (): void => {
    try {
      rmSync(aburi.directory, { recursive: true, force: true })
    } catch (error) {
      say(`could not remove ${aburi.directory}: ${messageOf(error)}`)
    }
  }
  const endOn = (signal: (typeof SIGNALS)[number]): void => {
    for (const each of SIGNALS) process.removeAllListeners(each)
    // Windows has no signal to end on, so the exit code says which one it was, as aburi's does.
    if (process.platform === "win32") process.exit(128 + constants.signals[signal])
    // A process that dies of a signal runs no `exit` listener.
    removeDirectory()
    process.kill(process.pid, signal)
  }
  // Stdin closing cancels the calls in flight, and the process ends once their runs have.
  process.on("exit", removeDirectory)
  let stopping = false
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      // A second signal does not wait for the runs to end.
      if (stopping) return endOn(signal)
      stopping = true
      void connection
        .close()
        .catch((error: unknown) => say(messageOf(error)))
        .then(() => aburi.close())
        .finally(() => endOn(signal))
    })
  }
}

function say(line: string): void {
  process.stderr.write(`aburi-mcp: ${line}\n`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseOptions() {
  return parseArgs({
    options: {
      cwd: { type: "string" },
      config: { type: "string" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  }).values
}

main()

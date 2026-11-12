// The other end of a plugin process, standing in for a parser written in another language.
import { appendFileSync, closeSync, openSync } from "node:fs"
import { devNull } from "node:os"
import { createInterface } from "node:readline"

// --hold outlives its stdin and SIGTERM, --stay its stdin alone.
const hold = process.argv.includes("--hold")
const stay = hold || process.argv.includes("--stay")
if (hold) process.on("SIGTERM", () => {})
if (stay) setInterval(() => {}, 1_000)
const startsFile = process.env.PEER_STARTS
if (startsFile !== undefined) appendFileSync(startsFile, "x")
const exitsFile = process.env.PEER_EXITS
if (exitsFile !== undefined) process.on("exit", () => appendFileSync(exitsFile, "x"))
if (process.argv.includes("--exit-at-start")) process.exit(4)

const write = (text) => process.stdout.write(text)
const answer = (id, body) => write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`)

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const { id, method, params } = JSON.parse(line)
    switch (method) {
      case "request":
        return answer(id, { result: line })
      case "pid":
        return answer(id, { result: process.pid })
      case "delay":
        return setTimeout(() => answer(id, { result: params.value }), params.ms)
      case "fail":
        return answer(id, { error: { code: -32000, message: params.message } })
      case "crash":
        process.stderr.write(params.stderr)
        return process.exit(params.code)
      case "big":
        return write(`${JSON.stringify({ id, result: params.text.repeat(params.times) })}\n`)
      case "env":
        return answer(id, { result: process.env[params.name] ?? null })
      case "say":
        return write(`${params.line.replaceAll("$ID", String(id))}\n`)
      case "deafen":
        process.stdin.destroy()
        // Destroying the stream alone leaves the descriptor open, and a write to it unanswered. A
        // descriptor libuv opens later must not be numbered 0, or closing it aborts the process.
        closeSync(0)
        openSync(devNull, "r")
        return answer(id, { result: true })
      case "garbage":
        return write("Traceback (most recent call last):\n")
      case "crlf":
        return write(`${JSON.stringify({ id, result: "ok" })}\r\n`)
      default:
        return undefined
    }
  })
  .on("close", () => {
    if (!stay) process.exit(0)
  })

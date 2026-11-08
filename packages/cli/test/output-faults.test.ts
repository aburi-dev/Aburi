import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { holdRefusedWrites } from "../src/output-faults"

class FakeStream extends EventEmitter {
  written = ""
  write(text: string): boolean {
    this.written += text
    return true
  }
}

class FakeProcess extends EventEmitter {
  exitCode: number | undefined = undefined
}

function systemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

const EBADF = systemError("EBADF", "EBADF: bad file descriptor, write")

function watched() {
  const streams = { stdout: new FakeStream(), stderr: new FakeStream() }
  const host = new FakeProcess()
  holdRefusedWrites(streams, host)
  return { ...streams, host }
}

describe("holdRefusedWrites", () => {
  it("names a refusal only once the event loop drains, even one that arrived after the run returned", () => {
    const { stdout, stderr, host } = watched()
    host.exitCode = 0

    stdout.emit("error", EBADF)
    expect(host.exitCode).toBe(0)
    expect(stderr.written).toBe("")

    host.emit("beforeExit")
    expect(host.exitCode).toBe(1)
    expect(stderr.written).toBe(
      "aburi: could not write to stdout: EBADF: bad file descriptor, write\n",
    )
    expect(stdout.written).toBe("")
  })

  it("leaves a reader that stopped early to the code the run reached", () => {
    const { stdout, stderr, host } = watched()
    host.exitCode = 3

    stdout.emit("error", systemError("EPIPE", "write EPIPE"))
    stderr.emit("error", systemError("EPIPE", "write EPIPE"))
    host.emit("beforeExit")

    expect(host.exitCode).toBe(3)
    expect(stdout.written + stderr.written).toBe("")
  })

  it("names the first refusal when both streams refuse, and absorbs the notice's own", () => {
    const { stdout, stderr, host } = watched()

    stderr.emit("error", systemError("EIO", "EIO: i/o error, write"))
    stdout.emit("error", EBADF)
    host.emit("beforeExit")
    stdout.emit("error", EBADF)

    expect(host.exitCode).toBe(1)
    expect(stdout.written).toBe("aburi: could not write to stderr: EIO: i/o error, write\n")
  })

  it("names an error that carries no code by its message", () => {
    const { stdout, stderr, host } = watched()

    stderr.emit("error", new Error("the stream was destroyed"))
    host.emit("beforeExit")

    expect(stdout.written).toBe("aburi: could not write to stderr: the stream was destroyed\n")
    expect(stderr.written).toBe("")
  })

  it("writes the notice once, though its write keeps the process alive and drains again", () => {
    const { stdout, stderr, host } = watched()

    stdout.emit("error", EBADF)
    host.emit("beforeExit")
    host.emit("beforeExit")

    expect(stderr.written).toBe(
      "aburi: could not write to stdout: EBADF: bad file descriptor, write\n",
    )
  })
})

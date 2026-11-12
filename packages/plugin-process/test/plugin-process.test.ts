import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { useScratchWorkspace } from "@aburi/test-support"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createPluginProcess,
  isPluginProcessError,
  type PluginProcess,
  PluginProcessError,
  type PluginProcessErrorCode,
  type PluginProcessOptions,
} from "../src"
import { isRunning } from "./processes"

const PEER = fileURLToPath(new URL("./fixtures/peer.mjs", import.meta.url))
const NAME = `${process.execPath} ${PEER}`

const scratch = useScratchWorkspace("plugin-process")
let opened: PluginProcess[] = []

afterEach(async () => {
  await Promise.all(opened.map((plugin) => plugin.close()))
  opened = []
})

function peer(options: Partial<PluginProcessOptions> = {}, flags: string[] = []): PluginProcess {
  const plugin = createPluginProcess({
    command: process.execPath,
    args: [PEER, ...flags],
    ...options,
  })
  opened.push(plugin)
  return plugin
}

describe("a plugin process", () => {
  it("sends each request as one JSON-RPC line, leaving out params it was not given", async () => {
    const plugin = peer()

    expect(await plugin.request("request", { file: "a.py" })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"request","params":{"file":"a.py"}}',
    )
    expect(await plugin.request("request")).toBe('{"jsonrpc":"2.0","id":2,"method":"request"}')
  })

  it("matches answers that come back out of order to their requests, on one process", async () => {
    const plugin = peer()
    const pid = await plugin.request("pid")

    const answers = await Promise.all([
      plugin.request("delay", { ms: 200, value: "slow" }),
      plugin.request("delay", { ms: 0, value: "fast" }),
      plugin.request("crlf"),
    ])

    expect(answers).toEqual(["slow", "fast", "ok"])
    expect(await plugin.request("pid")).toBe(pid)
  })

  it("rejects a request answered with an error and keeps the process", async () => {
    const plugin = peer()
    const pid = await plugin.request("pid")

    await expect(plugin.request("fail", { message: "no tree for a.py" })).rejects.toMatchObject({
      code: "error-response",
      message: `${NAME} answered fail with an error: no tree for a.py`,
      rpcError: { code: -32000, message: "no tree for a.py" },
    })
    expect(await plugin.request("pid")).toBe(pid)
  })

  it.each<[string, Partial<PluginProcessOptions>, string, unknown, PluginProcessErrorCode, RegExp]>(
    [
      [
        "exits",
        {},
        "crash",
        { code: 3, stderr: "boom\n" },
        "exited",
        /exited with code 3\. It wrote on stderr:\nboom$/,
      ],
      [
        "answers nothing in time",
        {},
        "hang",
        undefined,
        "timeout",
        /did not answer hang within 300ms$/,
      ],
      [
        "writes a line over maxResponseBytes",
        { maxResponseBytes: 1_024 },
        "big",
        { text: "x", times: 2_048 },
        "oversize",
        /wrote a line longer than maxResponseBytes \(1024 bytes\)$/,
      ],
      [
        "writes a line over maxResponseBytes across several reads",
        { maxResponseBytes: 100_000 },
        "big",
        { text: "x", times: 300_000 },
        "oversize",
        /wrote a line longer than maxResponseBytes \(100000 bytes\)$/,
      ],
      [
        "writes a line that is no answer",
        {},
        "garbage",
        undefined,
        "protocol",
        /answers no request it was sent: Traceback \(most recent call last\):$/,
      ],
    ],
  )(
    "rejects a request when the process %s, and starts another for the next",
    async (_, options, method, params, code, says) => {
      const plugin = peer(options)
      const pid = await plugin.request("pid")

      const failed = plugin.request(method, params, method === "hang" ? { timeoutMs: 300 } : {})

      await expect(failed).rejects.toBeInstanceOf(PluginProcessError)
      await expect(failed).rejects.toMatchObject({ code, message: expect.stringMatching(says) })
      const next = await plugin.request("pid")
      expect(next).not.toBe(pid)
      await expect.poll(() => isRunning(pid as number)).toBe(false)
    },
  )

  it("answers with a line of several reads whose multi-byte characters straddle them", async () => {
    const plugin = peer()
    const text = "€".repeat(400_000)

    expect(await plugin.request("big", { text: "€", times: 400_000 })).toBe(text)
  })

  it.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a string id", '{"id":"$ID","result":1}'],
    ["neither result nor error", '{"id":$ID}'],
    ["both result and error", '{"id":$ID,"result":1,"error":{"code":1,"message":"no"}}'],
    ["an error that is not an error object", '{"id":$ID,"error":"no"}'],
    ["an error with no integer code", '{"id":$ID,"error":{"code":"E1","message":"no"}}'],
    ["an id no request waits on", '{"id":999,"result":1}'],
  ])("ends the process on a line on stdout that is %s", async (_, line) => {
    const plugin = peer()
    const pid = (await plugin.request("pid")) as number

    await expect(plugin.request("say", { line })).rejects.toMatchObject({
      code: "protocol",
      message: expect.stringContaining("answers no request it was sent: "),
    })
    await expect.poll(() => isRunning(pid)).toBe(false)
  })

  it("rejects every request still waiting when the process ends", async () => {
    const plugin = peer()
    const outcomes = await Promise.allSettled([
      plugin.request("delay", { ms: 10_000, value: "never" }),
      plugin.request("crash", { code: 1, stderr: "" }),
    ])

    expect(outcomes.map((outcome) => outcome.status === "rejected" && outcome.reason)).toEqual([
      expect.objectContaining({ code: "exited", message: `${NAME} exited with code 1` }),
      expect.objectContaining({ code: "exited", message: `${NAME} exited with code 1` }),
    ])
  })

  it("stops starting a process that ends three times without answering, until it is closed", async () => {
    const starts = join(scratch.root, "starts")
    const plugin = peer({ env: { PEER_STARTS: starts } }, ["--exit-at-start"])

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(plugin.request("pid")).rejects.toMatchObject({ code: "exited" })
    }
    await expect(plugin.request("pid")).rejects.toMatchObject({
      code: "abandoned",
      message: `${NAME} --exit-at-start ended 3 times without answering a request, so no more are sent to it. The last time: ${NAME} --exit-at-start exited with code 4`,
    })
    expect(await readFile(starts, "utf8")).toBe("xxx")

    await plugin.close()
    await expect(plugin.request("pid")).rejects.toMatchObject({ code: "exited" })
    expect(await readFile(starts, "utf8")).toBe("xxxx")
  })

  it("abandons only processes that end without answering three times in a row", async () => {
    const plugin = peer()
    const crash = () =>
      expect(plugin.request("crash", { code: 1, stderr: "" })).rejects.toMatchObject({
        code: "exited",
      })

    await crash()
    await crash()
    await plugin.request("pid")
    await crash()
    await crash()
    await crash()
    expect(await plugin.request("pid")).toEqual(expect.any(Number))
  })

  it("counts a command that spawn refuses outright as a start that failed", async () => {
    const plugin = peer({ command: "", args: [] })

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(plugin.request("pid")).rejects.toMatchObject({
        code: "start-failed",
        message: expect.stringMatching(/^Could not start : /),
      })
    }
    await expect(plugin.request("pid")).rejects.toMatchObject({ code: "abandoned" })
  })

  it("fails a request when the command cannot be started", async () => {
    const plugin = peer({ command: "aburi-no-such-command", args: [] })

    await expect(plugin.request("pid")).rejects.toMatchObject({
      code: "start-failed",
      message: expect.stringMatching(/^Could not start aburi-no-such-command: .*ENOENT/),
    })
  })

  it("ends the process on close, rejecting what it has not answered, and starts another after", async () => {
    const plugin = peer()
    const pid = (await plugin.request("pid")) as number
    const hanging = expect(plugin.request("hang")).rejects.toMatchObject({
      code: "closed",
      message: `${NAME} was closed before it answered`,
    })

    await plugin.close()

    await hanging
    expect(isRunning(pid)).toBe(false)
    expect(await plugin.request("pid")).not.toBe(pid)
  })

  it("kills on close a process that holds SIGTERM and outlives its stdin", async () => {
    const plugin = peer({}, ["--hold"])
    const pid = (await plugin.request("pid")) as number

    await plugin.close()

    expect(isRunning(pid)).toBe(false)
  })

  it("waits on close for a process it is still ending as well as the one running", async () => {
    const plugin = peer({}, ["--hold"])
    const first = (await plugin.request("pid")) as number
    await expect(plugin.request("hang", undefined, { timeoutMs: 100 })).rejects.toMatchObject({
      code: "timeout",
    })
    const second = (await plugin.request("pid")) as number

    await plugin.close()

    expect(second).not.toBe(first)
    expect([isRunning(first), isRunning(second)]).toEqual([false, false])
  })

  // Node never closes descriptors 0 to 2 on Windows, so the peer cannot stop reading its stdin there.
  it.skipIf(process.platform === "win32")(
    "ends a process that stops reading its stdin, saying so",
    async () => {
      const plugin = peer({}, ["--stay"])
      await plugin.request("deafen")

      await expect(plugin.request("pid")).rejects.toMatchObject({
        code: "exited",
        message: expect.stringMatching(/ended on SIGTERM\. Its stdin had closed: .*EPIPE/),
      })
    },
  )

  it.skipIf(process.platform === "win32")(
    "ends a process whose launcher leaves its parser holding its pipes",
    async () => {
      const plugin = createPluginProcess({
        command: "sh",
        args: ["-c", `"${process.execPath}" "${PEER}" --hold; true`],
      })
      const parser = (await plugin.request("pid")) as number

      try {
        await plugin.close()
      } finally {
        process.kill(parser, "SIGKILL")
      }
    },
  )

  it("merges its environment over the host's, leaving out a variable set to undefined", async () => {
    vi.stubEnv("PEER_KEPT", "host")
    vi.stubEnv("PEER_GONE", "host")
    vi.stubEnv("Peer_Folded", "host")
    try {
      const plugin = peer({
        env: { PEER_PROBE: "set", PEER_GONE: undefined, PEER_FOLDED: undefined },
      })
      const read = (name: string) => plugin.request("env", { name })

      expect(await read("PEER_PROBE")).toBe("set")
      expect(await read("PEER_KEPT")).toBe("host")
      expect(await read("PEER_GONE")).toBeNull()
      expect(await read("Peer_Folded")).toBe(process.platform === "win32" ? null : "host")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("reads a timeoutMs too long for a timer as the longest one", async () => {
    const plugin = peer({ timeoutMs: Number.MAX_SAFE_INTEGER })

    expect(await plugin.request("delay", { ms: 50, value: "waited" })).toBe("waited")
    expect(await plugin.request("delay", { ms: 50, value: "again" }, { timeoutMs: 2 ** 32 })).toBe(
      "again",
    )
  })

  it("refuses a request whose timeoutMs is not a positive integer", async () => {
    const plugin = peer()

    await expect(plugin.request("pid", undefined, { timeoutMs: 0 })).rejects.toThrow(
      new RangeError("timeoutMs must be a positive integer (got 0)"),
    )
  })

  it.each<[Partial<PluginProcessOptions>, string]>([
    [{ timeoutMs: 0 }, "timeoutMs must be a positive integer (got 0)"],
    [{ timeoutMs: 1.5 }, "timeoutMs must be a positive integer (got 1.5)"],
    [{ maxResponseBytes: -1 }, "maxResponseBytes must be a positive integer (got -1)"],
  ])("refuses the options %o", (options, says) => {
    expect(() => createPluginProcess({ command: process.execPath, ...options })).toThrow(
      new RangeError(says),
    )
  })
})

describe("isPluginProcessError", () => {
  it.each<[string, unknown, boolean]>([
    ["one of its own", new PluginProcessError("ended", "exited"), true],
    [
      "one from another copy of the package",
      Object.assign(new Error("ended"), { name: "PluginProcessError", code: "timeout" }),
      true,
    ],
    [
      "one so named with a code of no plugin process",
      Object.assign(new Error("ended"), { name: "PluginProcessError", code: "ENOENT" }),
      false,
    ],
    ["another error", new TypeError("ended"), false],
    ["a value that is no error", { name: "PluginProcessError", code: "exited" }, false],
  ])("recognises %s: %s", (_, error, recognised) => {
    expect(isPluginProcessError(error)).toBe(recognised)
  })
})

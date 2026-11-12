import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { access, readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { gitTestEnv, useScratchWorkspace } from "@aburi/test-support"
import { beforeAll, describe, expect, it } from "vitest"
import { hangingPlugin, writeRepository } from "./workspace"

const BIN = fileURLToPath(new URL("../dist/bin/aburi-mcp.mjs", import.meta.url))

const workspace = useScratchWorkspace("mcp-bin")
const temporary = useScratchWorkspace("mcp-bin-tmp")

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error(`${BIN} is missing: build @aburi/mcp before this file.`)
})

interface Reply {
  id?: number
  result?: Record<string, unknown>
  error?: unknown
}

function start(argv: readonly string[]) {
  const child = spawn(process.execPath, [BIN, ...argv], {
    // Its directory is made here, so a test sees whether it is still there.
    env: {
      ...gitTestEnv(workspace.root),
      TMPDIR: temporary.root,
      TEMP: temporary.root,
      TMP: temporary.root,
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  const exited = new Promise<{ code: number | null; stderr: string }>((done) =>
    child.on("close", (code) => done({ code, stderr })),
  )
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let next = 1
  async function ask(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    const id = next++
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    for (;;) {
      const line = await lines.next()
      if (line.done === true) throw new Error(`aburi-mcp closed stdout before answering ${method}`)
      const reply = JSON.parse(line.value) as Reply
      if (reply.id === id) return reply
    }
  }
  function tell(method: string, params: Record<string, unknown> = {}): void {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }
  async function initialize(): Promise<Reply> {
    const initialized = await ask("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    })
    tell("notifications/initialized")
    return initialized
  }
  return { child, ask, tell, initialize, exited }
}

describe("aburi-mcp", () => {
  it("answers over stdio until stdin closes, then exits and removes its directory", async () => {
    await writeRepository(workspace)
    const server = start(["--cwd", workspace.root])

    const initialized = await server.initialize()
    const listed = await server.ask("tools/list")
    const scanned = await server.ask("tools/call", { name: "scan", arguments: {} })
    const structured = scanned.result?.structuredContent as {
      scan: string
      runs: { argv: string[] }[]
    }
    const directory = dirname(structured.runs[0]?.argv[2] ?? "")
    await access(directory)
    server.child.stdin.end()

    expect(initialized.result?.serverInfo).toMatchObject({ name: "aburi" })
    const tools = (listed.result?.tools ?? []) as { name: string }[]
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "component",
      "diff",
      "explain",
      "scan",
      "workspace",
    ])
    expect(scanned.result?.isError).not.toBe(true)
    expect(structured.scan).toBe("scan-1")
    expect((await server.exited).code).toBe(0)
    await expect(access(directory)).rejects.toThrow()
  })

  it("ends a run still going once stdin closes, then exits and removes its directory", async () => {
    await writeRepository(workspace, { languages: ["./hanging-plugin.mjs"] })
    await workspace.writeSource("hanging-plugin.mjs", hangingPlugin())
    const server = start(["--cwd", workspace.root])
    await server.initialize()
    server.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "scan", arguments: {} } })}\n`,
    )
    const pidFile = join(workspace.root, "hanging.pid")
    await expect
      .poll(() => readFile(pidFile, "utf8").catch(() => ""), { timeout: 20_000 })
      .not.toBe("")
    const pid = Number(await readFile(pidFile, "utf8"))
    server.child.stdin.end()

    expect((await server.exited).code).toBe(0)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(await readdir(temporary.root)).toEqual([])
  })

  it("exits 2 naming an argument it does not take", async () => {
    const { code, stderr } = await start(["--bogus"]).exited

    expect(code).toBe(2)
    expect(stderr).toContain("--bogus")
  })
})

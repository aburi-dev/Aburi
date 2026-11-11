import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { useScratchWorkspace } from "@aburi/test-support"
import { beforeAll, expect, it } from "vitest"
import { isRunning } from "./processes"

const DIST = fileURLToPath(new URL("../dist/index.mjs", import.meta.url))
const PEER = fileURLToPath(new URL("./fixtures/peer.mjs", import.meta.url))

const scratch = useScratchWorkspace("plugin-process-host")

beforeAll(() => {
  if (!existsSync(DIST)) throw new Error(`${DIST} is missing: build @aburi/plugin-process first.`)
})

/** Runs `lines` as a host's ES module, after one that creates `plugin` over the peer with `flags`. */
async function host(
  flags: readonly string[],
  lines: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string }> {
  const script = [
    `import { createPluginProcess } from ${JSON.stringify(pathToFileURL(DIST).href)}`,
    `const plugin = createPluginProcess({ command: process.execPath, args: ${JSON.stringify([PEER, ...flags])} })`,
    ...lines,
  ].join("\n")
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
    // A host the process holds open would otherwise outlive the test.
    signal: AbortSignal.timeout(20_000),
  })
  child.on("error", () => {})
  let stdout = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
  })
  const code = await new Promise<number | null>((done) => child.on("close", done))
  return { code, stdout }
}

it("lets its host exit with a process it never closed sitting idle, which then exits too", async () => {
  const exits = join(scratch.root, "exits")
  const { code, stdout } = await host(
    [],
    ['process.stdout.write(String(await plugin.request("pid")))'],
    { PEER_EXITS: exits },
  )

  expect(code).toBe(0)
  expect(Number(stdout)).toBeGreaterThan(0)
  // An orphan is not always reaped, so the process says it exited rather than leaving it to its pid.
  // On Windows it can take over a second to see its stdin close once the host is gone.
  await expect.poll(() => readFile(exits, "utf8").catch(() => ""), { timeout: 10_000 }).toBe("x")
})

it("keeps its host alive until close has ended a process that holds SIGTERM", async () => {
  // Top-level await settles nothing if the loop empties first: the host would exit 13.
  const { code, stdout } = await host(
    ["--hold"],
    [
      'process.stdout.write(String(await plugin.request("pid")) + " ")',
      "await plugin.close()",
      'process.stdout.write("closed")',
    ],
  )
  const [pid, said] = stdout.split(" ")

  expect(code).toBe(0)
  expect(said).toBe("closed")
  expect(isRunning(Number(pid))).toBe(false)
})

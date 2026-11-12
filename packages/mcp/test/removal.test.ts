import { rm } from "node:fs/promises"
import { gitTestEnv, useScratchWorkspace } from "@aburi/test-support"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AburiServer, createAburiServer } from "../src"
import { installWorkspaceCli, writeRepository } from "./workspace"

const busy = vi.hoisted(() => ({ refuses: (_path: string): boolean => false }))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const refusing: typeof actual.rm = (path, options) =>
    busy.refuses(String(path))
      ? Promise.reject(
          Object.assign(new Error(`EBUSY: resource busy or locked, rm '${String(path)}'`), {
            code: "EBUSY",
          }),
        )
      : actual.rm(path, options)
  return { ...actual, rm: refusing }
})

const workspace = useScratchWorkspace("mcp-removal")

let aburi: AburiServer | null = null
let client: Client | null = null

afterEach(async () => {
  busy.refuses = () => false
  await client?.close()
  await aburi?.close()
  aburi = null
  client = null
})

// Writes the report every diff asks for, as aburi diff does.
const REPORTING_CLI = `import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const output = process.argv[process.argv.indexOf("--output-dir") + 1]
mkdirSync(output, { recursive: true })
writeFileSync(join(output, "diff.json"), "{}")
writeFileSync(join(output, "diff.md"), "# the report\\n")
`

async function served(): Promise<{ client: Client; warned: string[] }> {
  await writeRepository(workspace)
  await installWorkspaceCli(workspace, REPORTING_CLI)
  const warned: string[] = []
  aburi = createAburiServer({
    cwd: workspace.root,
    env: gitTestEnv(workspace.root),
    version: "0.0.0-test",
    warn: (line) => warned.push(line),
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await aburi.server().connect(serverSide)
  client = new Client({ name: "test", version: "0.0.0" })
  await client.connect(clientSide)
  return { client, warned }
}

describe("a directory the server cannot remove", () => {
  it("leaves the answer it computed, and is reported", async () => {
    const { client, warned } = await served()
    busy.refuses = (path) => /diff-\d+$/.test(path)
    const result = await client.callTool({ name: "diff", arguments: { refspec: "HEAD..HEAD" } })

    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "# the report\n" }])
    expect(warned).toEqual([
      expect.stringMatching(/^could not remove .*diff-1: EBUSY: resource busy or locked/),
    ])
  })

  it("leaves the server to close, and is reported", async () => {
    const { warned } = await served()
    const directory = aburi?.directory ?? ""
    busy.refuses = (path) => path === directory
    const closing = aburi
    aburi = null
    await closing?.close()
    busy.refuses = () => false
    await rm(directory, { recursive: true, force: true })

    expect(warned).toEqual([
      `could not remove ${directory}: EBUSY: resource busy or locked, rm '${directory}'`,
    ])
  })
})

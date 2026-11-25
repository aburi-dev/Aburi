import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { useScratchWorkspace } from "../src"

const workspace = useScratchWorkspace("scratch-workspace")

function readWhileCollecting(): unknown {
  try {
    return workspace.root
  } catch (error) {
    return error
  }
}

const collected = readWhileCollecting()

describe("useScratchWorkspace", () => {
  it("refuses its root to code that runs while the tests are collected", () => {
    expect(collected).toEqual(
      new Error(
        'the "scratch-workspace" scratch workspace has no directory outside a test or its hooks',
      ),
    )
  })

  it("writes each file's lines, every one ended with a line break, creating its directories", async () => {
    await workspace.writeSources({ "src/lib/a.ts": ["const a = 1", ""], "b.ts": [] })

    expect(await readFile(join(workspace.root, "src/lib/a.ts"), "utf8")).toBe("const a = 1\n\n")
    expect(await readFile(join(workspace.root, "b.ts"), "utf8")).toBe("")
  })
})

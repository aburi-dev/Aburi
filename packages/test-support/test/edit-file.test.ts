import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { editFile, useScratchWorkspace } from "../src"

const workspace = useScratchWorkspace("edit-file")

describe("editFile", () => {
  it("replaces the one occurrence, taking the replacement literally", async () => {
    await workspace.writeSource("a.ts", "const a = 1\nconst b = 2\n")

    await editFile(join(workspace.root, "a.ts"), "const b = 2", "const b = `$&`")

    expect(await readFile(join(workspace.root, "a.ts"), "utf8")).toBe(
      "const a = 1\nconst b = `$&`\n",
    )
  })

  it.each([
    ["is missing", "const c = 3", 0],
    ["occurs twice", "const", 2],
  ])("refuses a target that %s, and leaves the file as it was", async (_, from, occurrences) => {
    await workspace.writeSource("a.ts", "const a = 1\nconst b = 2\n")
    const path = join(workspace.root, "a.ts")

    await expect(editFile(path, from, "x")).rejects.toThrow(`${occurrences} times, not once`)
    expect(await readFile(path, "utf8")).toBe("const a = 1\nconst b = 2\n")
  })
})

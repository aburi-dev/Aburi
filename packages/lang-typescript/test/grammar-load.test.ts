import { scanWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import { afterEach, expect, it, vi } from "vitest"
import { Language } from "web-tree-sitter"
import { langTypescriptPlugin } from "../src/index"

// The grammars load once per module instance, so this file holds the one scan that loads them.

const workspace = useScratchWorkspace("grammar-load")

const BUDGET_MS = 100

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it("loads every grammar before a file's parse budget starts, however long the load takes", async () => {
  vi.useFakeTimers({ toFake: ["performance"] })
  const load = Language.load.bind(Language)
  const slowLoad = vi.spyOn(Language, "load").mockImplementation(async (input) => {
    vi.advanceTimersByTime(BUDGET_MS * 3)
    return load(input)
  })
  await workspace.writeSources({
    "src/a.ts": ["export function first() { return 1 }"],
    "src/b.tsx": ["export function View() { return <div /> }"],
    "src/c.js": ["export function last() { return 2 }"],
  })

  const { ir, skipped } = await scanWith(
    workspace.root,
    { languages: [langTypescriptPlugin] },
    { parseTimeoutMs: BUDGET_MS },
  )

  expect(skipped).toEqual([])
  expect(ir.symbols.map((symbol) => symbol.name).sort()).toEqual(["View", "first", "last"])
  expect(slowLoad).toHaveBeenCalledTimes(2)
})

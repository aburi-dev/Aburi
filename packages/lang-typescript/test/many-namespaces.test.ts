import { describe, expect, it } from "vitest"
import { STATEMENT_LISTS } from "../src/extract-symbols"
import { walksOf } from "./fixtures/ctx"
import { readingNodes } from "./fixtures/node-reads"

const LIST_GETTERS: ReadonlySet<string> = new Set(["namedChildren", "children"])
const CHILD_METHODS: ReadonlySet<string> = new Set(["namedChild", "child"])

// Counts the children read off statement lists. Every way of reading them is counted, so a rewrite
// stays guarded.
async function childrenRead(source: string): Promise<number> {
  let reads = 0
  await readingNodes(
    (node, member, value) => {
      if (!STATEMENT_LISTS.has(node.type)) return
      if (LIST_GETTERS.has(member) && Array.isArray(value)) reads += value.length
      else if (CHILD_METHODS.has(member)) reads += 1
    },
    () => walksOf(source),
  )
  return reads
}

function topLevel(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `export namespace Api${i} {\n  export const path = "/v1/r${i}"\n}\n`,
  ).join("")
}

function nested(count: number): string {
  return `export namespace Pets {\n${topLevel(count)}}\n`
}

const FEW = 10
const MANY = 400

describe("a file of many namespaces", () => {
  it.each([
    ["at the top level", topLevel],
    ["inside one outer namespace", nested],
  ])("reads statement lists in proportion to the file %s", async (_, shape) => {
    const few = await childrenRead(shape(FEW))
    const many = await childrenRead(shape(MANY))
    // Between linear and quadratic growth on purpose, so the guard is neither tight nor blind.
    expect(many).toBeLessThan(few * (MANY / FEW) * 2)
  })
})

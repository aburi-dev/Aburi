import {
  emptySummary,
  fp,
  headings,
  makeDiff,
  makeSymbol,
  rule,
  sectionOf,
} from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { bytes, noteOf } from "./markdown"

const COMMENT_BUDGET = 65507
const COUNT = 1200

/** Named in id order, the order the section lists them in. */
function handler(i: number): IRSymbol {
  const name = `handler${String(i).padStart(4, "0")}`
  return makeSymbol({
    id: `ts:src/handlers.ts#${name}`,
    name,
    source: {
      file: "src/handlers.ts",
      startLine: 1 + 5 * i,
      endLine: 4 + 5 * i,
      startColumn: null,
      endColumn: null,
    },
    fingerprint: fp(name),
    rules: [
      rule({
        type: "throw",
        condition: `input.length > ${i}`,
        what: 'new Error("too long")',
        line: 2 + 5 * i,
      }),
      rule({ type: "return", expr: `input.length + ${i}`, line: 3 + 5 * i }),
    ],
  })
}

describe("projectDiff — maxBytes over a list too long even for its names", () => {
  const removed = Array.from({ length: COUNT }, (_, i) => handler(i))
  const diff = makeDiff({
    summary: { ...emptySummary(), removed: COUNT },
    symbols: removed.map((symbol) => ({ status: "removed" as const, symbol })),
  })
  const row = (symbol: IRSymbol) =>
    `- \`${symbol.name}\` *(function)* — \`${symbol.source.file}:${symbol.source.startLine}\``
  const md = projectDiff(diff, { maxBytes: COMMENT_BUDGET })
  const [, , cutLine = "", , ...rows] = sectionOf(md, "## ➖ Removed")
  const shown = Number(/first (\d+) of 1200 entries/.exec(cutLine)?.[1])

  it("names the first removed symbols that fit, in order, and counts the rest", () => {
    expect(bytes(md)).toBeLessThanOrEqual(COMMENT_BUDGET)
    expect(headings(md)).toEqual(["## ➖ Removed"])
    expect(shown).toBeGreaterThan(0)
    expect(rows.slice(0, shown + 1)).toEqual([
      ...removed.slice(0, shown).map(row),
      `- … and ${COUNT - shown} more`,
    ])
  })

  it("names as many as the budget holds", () => {
    const oneMore = md
      .replace(`first ${shown} of`, `first ${shown + 1} of`)
      .replace(
        `- … and ${COUNT - shown} more`,
        `${row(removed[shown] as IRSymbol)}\n- … and ${COUNT - shown - 1} more`,
      )
    expect(bytes(oneMore)).toBeGreaterThan(COMMENT_BUDGET)
  })

  it("says in the note that the section was cut short", () => {
    expect(noteOf(md)).toBe(
      `> ⚠ **1 section was cut short** to keep this report within ${COMMENT_BUDGET} bytes: ➖ Removed. The full report is the same diff rendered without a size cap.`,
    )
  })
})

import {
  changed,
  dependency,
  emptySummary,
  headings,
  makeDiff,
  sectionOf,
  sliceOf,
  symbolAt,
  withCallsTo,
} from "@aburi/test-support"
import type { DiffResult, Symbol as IRSymbol, SymbolChange, SymbolChangeStatus } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { ProjectionInvariantError, projectDiff } from "../src"
import { bytes } from "./markdown"

const added = (symbol: IRSymbol): SymbolChange => ({ status: "added", symbol })
const removed = (symbol: IRSymbol): SymbolChange => ({ status: "removed", symbol })

const checkout = symbolAt("src/checkout.ts", "checkout", 3)
const total = symbolAt("src/total.ts", "total", 7)
const legacy = symbolAt("src/legacy.ts", "legacy", 2)
const fixture = symbolAt("src/checkout.test.ts", "fixture", 4, { inTestFile: true })
const staleFixture = symbolAt("src/old.test.ts", "staleFixture", 1, { inTestFile: true })

/** An added caller joined by a Slice to a changed callee, a removal, and a test file of each. */
function mixedDiff(): DiffResult {
  return makeDiff({
    summary: { ...emptySummary(), added: 2, removed: 2, changed: 1 },
    symbols: [
      added(withCallsTo(checkout, [total, 5])),
      changed(total, { logicChanged: true }),
      removed(legacy),
      added(withCallsTo(fixture, [total, 6])),
      removed(staleFixture),
    ],
    slices: [sliceOf(checkout, total), sliceOf(legacy)],
    dependencies: {
      added: [
        dependency({ from: checkout.id, to: total.id, via: "call" }),
        dependency({ from: fixture.id, to: total.id, via: "call" }),
      ],
      removed: [dependency({ from: total.id, to: legacy.id, via: "call" })],
    },
  })
}

function filtered(statuses: readonly SymbolChangeStatus[]): string {
  return projectDiff(mixedDiff(), { statuses })
}

describe("projectDiff — a status filter", () => {
  it("lists the changes of the statuses named, and draws a Slice holding one of them whole", () => {
    const report = filtered(["added"])

    expect(headings(report)).toEqual([
      "## 🧵 Slice View",
      "## ➕ Added",
      "## 🔗 Dependency changes",
      "## 🧪 Test files",
    ])
    expect(sectionOf(report, "## 🧵 Slice View").join("\n")).toContain("`total`")
    expect(sectionOf(report, "## 🧵 Slice View").join("\n")).not.toContain("`legacy`")
    expect(sectionOf(report, "## ➕ Added").filter((line) => line.startsWith("### "))).toEqual([
      "### `checkout` *(function)*",
    ])
  })

  it("keeps the Summary's counts and says how many changes it left out, under the Summary", () => {
    const report = filtered(["added"])

    expect(report.split("\n").slice(2, 6)).toEqual([
      "**Summary**: +2 added · -2 removed · ~1 changed · 0 moved · 0 moved+changed · 2 in test files",
      "",
      "> ℹ **Only `added` changes are listed.** 3 other Symbol changes are left out of this report; the Summary counts them.",
      "",
    ])
    expect(sectionOf(report, "## 🧪 Test files")).toContain(
      "<summary>1 symbol in a test file</summary>",
    )
  })

  it.each([
    [
      "one Symbol change",
      mixedDiff(),
      ["added", "removed"],
      "1 other Symbol change is left out of this report; the Summary counts it.",
    ],
    [
      "Symbol changes and a test caller's edge",
      mixedDiff(),
      ["removed"],
      "3 other Symbol changes and 1 dependency change from test code are left out of this report; the Summary counts the Symbol changes.",
    ],
    [
      "one Symbol change and its edge",
      makeDiff({
        summary: { ...emptySummary(), added: 1, removed: 1 },
        symbols: [removed(legacy), added(withCallsTo(fixture, [total, 6]))],
        dependencies: {
          added: [dependency({ from: fixture.id, to: total.id, via: "call" })],
          removed: [],
        },
      }),
      ["removed"],
      "1 other Symbol change and 1 dependency change from test code are left out of this report; the Summary counts the Symbol change.",
    ],
  ] as const)("counts %s left out in the note", (_, diff, statuses, leftOut) => {
    expect(projectDiff(diff, { statuses }).split("\n")[4]).toBe(
      `> ℹ **Only ${statuses.map((status) => `\`${status}\``).join(" and ")} changes are listed.** ${leftOut}`,
    )
  })

  it("names the statuses in the order of the glyph line, a repeat once, whatever order they came in", () => {
    const note = filtered(["unknown", "removed", "added", "removed"]).split("\n")[4]

    expect(note).toBe(
      "> ℹ **Only `added`, `removed` and `unknown` changes are listed.** 1 other Symbol change is left out of this report; the Summary counts it.",
    )
  })

  it("writes the report it writes without a filter when the filter leaves nothing out", () => {
    expect(filtered(["added", "removed", "changed"])).toBe(projectDiff(mixedDiff()))
  })

  it("lists every dependency change, but a test caller's edge only with its caller", () => {
    const report = filtered(["removed"])

    const dependencyChanges = sectionOf(report, "## 🔗 Dependency changes").join("\n")
    expect(dependencyChanges).toContain("`checkout`")
    expect(dependencyChanges).toContain("`legacy`")
    expect(dependencyChanges).not.toContain("`fixture`")
    expect(sectionOf(report, "## 🧪 Test files").join("\n")).not.toContain("`fixture`")
    expect(sectionOf(report, "## 🧪 Test files")).toContain(
      "<summary>1 symbol in a test file</summary>",
    )
  })

  it("caps the filtered report, its note counted against the budget", () => {
    const uncapped = filtered(["added"])
    const maxBytes = bytes(uncapped) - 1

    const capped = projectDiff(mixedDiff(), { statuses: ["added"], maxBytes })

    expect(bytes(capped)).toBeLessThanOrEqual(maxBytes)
    expect(capped).toContain("> ℹ **Only `added` changes are listed.**")
    expect(capped.indexOf("> ℹ")).toBeLessThan(capped.indexOf("> ⚠"))
  })

  it("refuses a Slice naming a member no change holds, as it does without a filter", () => {
    const ghost = symbolAt("src/ghost.ts", "ghost", 1)
    const diff = { ...mixedDiff(), slices: [sliceOf(legacy, ghost)] }

    expect(() => projectDiff(diff)).toThrowError(ProjectionInvariantError)
    expect(() => projectDiff(diff, { statuses: ["added"] })).toThrowError(ProjectionInvariantError)
  })

  it.each([
    [[], /at least one status/],
    [["renamed"], /"renamed" is no Symbol change status/],
  ])("refuses %j", (statuses, message) => {
    expect(() =>
      projectDiff(mixedDiff(), { statuses: statuses as SymbolChangeStatus[] }),
    ).toThrowError(new RegExp(message.source))
  })
})

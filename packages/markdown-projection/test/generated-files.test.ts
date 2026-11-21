import {
  added,
  changed,
  dependency,
  headings,
  makeDiff,
  moved,
  removed,
  sectionOf,
  sliceOf,
  symbolAt,
  withCallsTo,
} from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { namedSymbol, projectChanges, relocated } from "./fixtures"
import { bytes, noteOf } from "./markdown"

const HEADING = "## ⚙ Generated files"

function generatedAt(
  file: string,
  name: string,
  line = 1,
  extra: Parameters<typeof symbolAt>[3] = {},
): IRSymbol {
  return symbolAt(file, name, line, { inGeneratedFile: true, ...extra })
}

function fixture(name: string): IRSymbol {
  return symbolAt(`src/${name}.test.ts`, name, 1, { inTestFile: true })
}

describe("projectDiff — the changes of generated files", () => {
  const order = namedSymbol("order")
  const loader = generatedAt("src/gen/a.ts", "loader", 3)
  const registry = generatedAt("src/gen/a.ts", "registry", 9)
  const before = symbolAt("src/client.ts", "client", 2)
  const generatedFixture = generatedAt("src/gen/b.test.ts", "fixture", 1, { inTestFile: true })
  const report = projectDiff(
    makeDiff({
      symbols: [
        changed(order, { logicChanged: true }),
        changed(generatedFixture, { apiChanged: true }),
        added(withCallsTo(loader, [order, 4])),
        moved(before, { ...relocated(before, "src/gen/a.ts"), inGeneratedFile: true }),
      ],
      dependencies: {
        added: [dependency({ from: loader.id, to: order.id, via: "call" })],
        removed: [],
      },
    }),
  )

  it("are one line in the last section, by file in code-unit order, test files included", () => {
    expect(headings(report)).toEqual(["## 🔧 Logic changes", HEADING])
    expect(sectionOf(report, HEADING)).toEqual([
      HEADING,
      "",
      "3 Symbol changes and 1 dependency change in 2 generated files: `src/gen/a.ts` (+1 ↔1), `src/gen/b.test.ts` (~1)",
      "",
    ])
  })

  it.each([
    ["out of a generated file is reviewed", false, "## 🔀 Moved"],
    ["into a generated file is generated code", true, HEADING],
  ])("are judged by the head, so a move %s", (_, intoGenerated, section) => {
    const parse = intoGenerated ? namedSymbol("parse") : generatedAt("src/gen/parse.ts", "parse")
    const { inGeneratedFile: _mark, ...unmarked } = relocated(parse, "src/parse/index.ts")
    const after: IRSymbol = intoGenerated ? { ...unmarked, inGeneratedFile: true } : unmarked
    expect(headings(projectChanges([moved(parse, after)]))).toEqual([section])
  })

  it("count each file's changes by status, and an unknown one by the skip that made it", () => {
    const toggled = generatedAt("src/gen/b.ts", "toggled", 5)
    const skipped = ["first", "second", "third"].map(
      (name): SymbolChange => ({
        status: "unknown",
        symbol: generatedAt("src/gen/a.ts", name),
        absentFrom: "head",
        reason: "over-size",
      }),
    )
    const counted = projectChanges([
      ...skipped,
      removed(generatedAt("src/gen/b.ts", "gone", 1)),
      changed(generatedAt("src/gen/b.ts", "kept", 3), { logicChanged: true }),
      {
        status: "dropped-toggled",
        before: toggled,
        after: { ...toggled, dropped: true, dropReason: "pure DTO" },
        direction: "to-dropped",
      },
    ])
    expect(headings(counted)).toEqual([HEADING])
    expect(sectionOf(counted, HEADING)).toContain(
      "6 Symbol changes in 2 generated files: `src/gen/a.ts` (?3 skipped at head: over-size), `src/gen/b.ts` (-1 ~1 💧1)",
    )
  })

  it("are counted on the Summary line, and not as test files", () => {
    expect(report).toContain(
      "**Summary**: +0 added · -0 removed · ~0 changed · 0 moved · 0 moved+changed · 3 in generated files\n",
    )
  })

  it("count one in the singular, and name no dependency change when there is none", () => {
    const one = projectChanges([added(registry)])
    expect(sectionOf(one, HEADING)).toContain(
      "1 Symbol change in 1 generated file: `src/gen/a.ts` (+1)",
    )
  })

  it("go first when the size cap omits a section, and the test files next", () => {
    const authored = [added(order)]
    const tests = Array.from({ length: 10 }, (_, i) => added(fixture(`mock${i}`)))
    const regenerated = Array.from({ length: 10 }, (_, i) =>
      added(generatedAt(`src/gen/registry-${i}.ts`, `entry${i}`)),
    )
    const everything = [...authored, ...tests, ...regenerated]
    const withoutGenerated = projectChanges(everything, {
      maxBytes: bytes(projectChanges([...authored, ...tests])) + 200,
    })
    expect(headings(withoutGenerated)).toEqual(["## ➕ Added", "## 🧪 Test files"])
    expect(noteOf(withoutGenerated)).toContain("**1 section was omitted**")
    expect(noteOf(withoutGenerated)).toContain(": ⚙ Generated files.")

    const authoredAlone = projectChanges(everything, {
      maxBytes: bytes(projectChanges(authored)) + 400,
    })
    expect(headings(authoredAlone)).toEqual(["## ➕ Added"])
    expect(noteOf(authoredAlone)).toContain("**2 sections were omitted**")
    expect(noteOf(authoredAlone)).toContain(": 🧪 Test files, ⚙ Generated files.")
  })
})

describe("projectDiff — the Slice View, beside generated files", () => {
  const route = symbolAt("src/route.ts", "route", 3)
  const loader = generatedAt("src/gen/routes.ts", "loader", 5)
  const table = generatedAt("src/gen/routes.ts", "table", 9)

  it("leaves out a Slice of generated code alone, and draws one reaching beyond it whole", () => {
    const alone = projectDiff(
      makeDiff({
        symbols: [added(withCallsTo(loader, [table, 6])), added(table)],
        slices: [sliceOf(loader, table)],
      }),
    )
    expect(headings(alone)).toEqual([HEADING])

    const reaching = projectDiff(
      makeDiff({
        symbols: [added(withCallsTo(loader, [route, 6])), added(route)],
        slices: [sliceOf(route, loader)],
      }),
    )
    expect(sectionOf(reaching, "## 🧵 Slice View").join("\n")).toContain("`loader`")
  })
})

describe("projectDiff — a status filter, beside generated files", () => {
  const legacy = symbolAt("src/legacy.ts", "legacy", 2)
  const total = symbolAt("src/total.ts", "total", 7)
  const loader = generatedAt("src/gen/a.ts", "loader", 4)
  const fixture = symbolAt("src/checkout.test.ts", "fixture", 4, { inTestFile: true })

  it.each([
    [
      "a generated caller's edge",
      [loader],
      "1 other Symbol change and 1 dependency change from generated files are left out of this report; the Summary counts the Symbol change.",
    ],
    [
      "a generated caller's edge and a test caller's",
      [loader, fixture],
      "2 other Symbol changes and 2 dependency changes from test code and generated files are left out of this report; the Summary counts the Symbol changes.",
    ],
  ])("counts %s left out in the note", (_, callers, leftOut) => {
    const diff = makeDiff({
      symbols: [
        { status: "removed", symbol: legacy },
        ...callers.map((caller) => added(withCallsTo(caller, [total, 6]))),
      ],
      dependencies: {
        added: callers.map((caller) => dependency({ from: caller.id, to: total.id, via: "call" })),
        removed: [],
      },
    })
    const report = projectDiff(diff, { statuses: ["removed"] })
    expect(report.split("\n")[4]).toBe(`> ℹ **Only \`removed\` changes are listed.** ${leftOut}`)
    expect(headings(report)).toEqual(["## ➖ Removed"])
  })
})

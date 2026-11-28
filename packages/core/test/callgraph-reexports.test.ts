import {
  importEdge,
  namespaceReexportEdge,
  reexportEdge,
  starReexportEdge,
} from "@aburi/test-support"
import type { ImportEdge, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { type ResolveCallGraphInput, resolveCallGraph } from "../src/callgraph"
import { edgesOf, type ImportClause, withCalls } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

/** Each module's import edges, by file. */
type Modules = Readonly<Record<string, readonly ImportClause[]>>

function importing(source: string, ...names: string[]): ImportClause {
  return { source, symbols: names }
}

/** One call from each file's `caller`, over modules written as their edges. */
function resolveThrough(
  calls: Readonly<Record<string, string>>,
  modules: Modules,
  callees: readonly IRSymbol[],
  input: Partial<ResolveCallGraphInput> = {},
) {
  const callers = Object.entries(calls).map(([file, target]) =>
    withCalls(`ts:${file}#caller`, [{ target, line: 3 }], { component: "billing" }),
  )
  const importsByFile = new Map<string, readonly ImportEdge[]>(
    Object.entries(modules).map(([file, edges]) => [file, edges.map(importEdge)]),
  )
  return resolveCallGraph({
    symbols: [...callers, ...callees],
    importsByFile,
    moduleFiles: new Map([["ts", new Set(importsByFile.keys())]]),
    ...input,
  })
}

type Result = ReturnType<typeof resolveCallGraph>

const bucketsOf = (result: Result) => result.diagnostics.map((d) => [d.bucket, d.candidates])

const classes = (...ids: string[]) => ids.map((id) => makeSymbol(id, { kind: "class" }))

describe("a call through a barrel", () => {
  it.each<[string, string, Modules, string[], string]>([
    [
      "a named re-export",
      "X",
      { "src/a.ts": [importing("./barrel", "X")], "src/barrel.ts": [reexportEdge("./x", "X")] },
      ["ts:src/x.ts#X"],
      "ts:src/x.ts#X",
    ],
    [
      "a renaming re-export",
      "X",
      {
        "src/a.ts": [importing("./barrel", "X")],
        "src/barrel.ts": [reexportEdge("./x", "Y as X")],
      },
      ["ts:src/x.ts#Y", "ts:src/x.ts#X"],
      "ts:src/x.ts#Y",
    ],
    [
      "a re-exported default",
      "X",
      {
        "src/a.ts": [importing("./barrel", "X")],
        "src/barrel.ts": [reexportEdge("./x", "default as X")],
      },
      ["ts:src/x.ts#<default>", "ts:src/x.ts#X"],
      "ts:src/x.ts#<default>",
    ],
    [
      "a star re-export",
      "X",
      { "src/a.ts": [importing("./barrel", "X")], "src/barrel.ts": [starReexportEdge("./x")] },
      ["ts:src/x.ts#X"],
      "ts:src/x.ts#X",
    ],
    [
      "a chain of barrels",
      "X",
      {
        "src/a.ts": [importing("./barrel", "X")],
        "src/barrel.ts": [starReexportEdge("./inner")],
        "src/inner.ts": [reexportEdge("./x", "X")],
      },
      ["ts:src/x.ts#X"],
      "ts:src/x.ts#X",
    ],
    [
      "a directory's index",
      "X",
      { "src/a.ts": [importing("./lib", "X")], "src/lib/index.ts": [starReexportEdge("./x")] },
      ["ts:src/lib/x.ts#X"],
      "ts:src/lib/x.ts#X",
    ],
    [
      "an alias of the barrel's name",
      "Z",
      {
        "src/a.ts": [importing("./barrel", "X as Z")],
        "src/barrel.ts": [reexportEdge("./x", "X")],
      },
      ["ts:src/x.ts#X"],
      "ts:src/x.ts#X",
    ],
    [
      "a default import of a barrel that re-exports a name as its default",
      "Z",
      {
        "src/a.ts": [importing("./barrel", "default as Z")],
        "src/barrel.ts": [reexportEdge("./x", "X as default")],
      },
      ["ts:src/x.ts#X"],
      "ts:src/x.ts#X",
    ],
    [
      "a namespace import of a barrel",
      "b.X",
      {
        "src/a.ts": [{ source: "./barrel", symbols: "*", namespaceBinding: "b" }],
        "src/barrel.ts": [starReexportEdge("./x")],
      },
      ["ts:src/x.ts#X"],
      "ts:src/x.ts#X",
    ],
    [
      "a namespace re-export",
      "ns.f",
      {
        "src/a.ts": [importing("./barrel", "ns")],
        "src/barrel.ts": [namespaceReexportEdge("./x", "ns")],
      },
      ["ts:src/x.ts#f"],
      "ts:src/x.ts#f",
    ],
    [
      "the barrel's own declaration ahead of its star re-exports",
      "X",
      { "src/a.ts": [importing("./barrel", "X")], "src/barrel.ts": [starReexportEdge("./x")] },
      ["ts:src/barrel.ts#X", "ts:src/x.ts#X"],
      "ts:src/barrel.ts#X",
    ],
    [
      "a named re-export ahead of a star re-export",
      "X",
      {
        "src/a.ts": [importing("./barrel", "X")],
        "src/barrel.ts": [starReexportEdge("./x"), reexportEdge("./y", "X")],
      },
      ["ts:src/x.ts#X", "ts:src/y.ts#X"],
      "ts:src/y.ts#X",
    ],
    [
      "two star re-exports that lead to one declaration",
      "X",
      {
        "src/a.ts": [importing("./barrel", "X")],
        "src/barrel.ts": [starReexportEdge("./x"), starReexportEdge("./y")],
        "src/y.ts": [starReexportEdge("./x")],
      },
      ["ts:src/x.ts#X"],
      "ts:src/x.ts#X",
    ],
    [
      "a star re-export beside one of a package",
      "X",
      {
        "src/a.ts": [importing("./barrel", "X")],
        "src/barrel.ts": [starReexportEdge("lodash"), starReexportEdge("./x")],
      },
      ["ts:src/x.ts#X"],
      "ts:src/x.ts#X",
    ],
  ])("reaches the declaration through %s", (_label, target, modules, callees, to) => {
    const result = resolveThrough({ "src/a.ts": target }, modules, classes(...callees))
    expect(edgesOf(result)).toEqual([["ts:src/a.ts#caller", to, "high"]])
  })

  it("composes a dotted tail past the declaration", () => {
    const run = makeSymbol("ts:src/x.ts#X.run", { kind: "method" })
    const result = resolveThrough(
      { "src/a.ts": "X.run" },
      { "src/a.ts": [importing("./barrel", "X")], "src/barrel.ts": [reexportEdge("./x", "X")] },
      [...classes("ts:src/x.ts#X"), run],
    )
    expect(edgesOf(result)).toEqual([["ts:src/a.ts#caller", run.id, "high"]])
  })

  it("follows a bare specifier the barrel's language maps into the workspace", () => {
    const result = resolveThrough(
      { "src/a.ts": "X" },
      { "src/a.ts": [importing("./barrel", "X")], "src/barrel.ts": [reexportEdge("@app/x", "X")] },
      classes("ts:src/lib/x.ts#X"),
      { specifierPaths: new Map([["src/barrel.ts", new Map([["@app/x", ["src/lib/x"]]])]]) },
    )
    expect(edgesOf(result)).toEqual([["ts:src/a.ts#caller", "ts:src/lib/x.ts#X", "high"]])
  })

  it("answers each barrel of a cycle that leads out of it", () => {
    const result = resolveThrough(
      { "src/a.ts": "X", "src/b.ts": "X" },
      {
        "src/a.ts": [importing("./one", "X")],
        "src/b.ts": [importing("./two", "X")],
        "src/one.ts": [starReexportEdge("./two"), starReexportEdge("./x")],
        "src/two.ts": [starReexportEdge("./one")],
      },
      classes("ts:src/x.ts#X"),
    )
    expect(edgesOf(result)).toEqual([
      ["ts:src/a.ts#caller", "ts:src/x.ts#X", "high"],
      ["ts:src/b.ts#caller", "ts:src/x.ts#X", "high"],
    ])
  })

  const disagreeing: Modules = {
    "src/a.ts": [importing("./barrel", "X")],
    "src/barrel.ts": [starReexportEdge("./x"), starReexportEdge("./y")],
  }

  it.each<[string, string, Modules, IRSymbol[], string[]]>([
    [
      "a call of the name",
      "X",
      disagreeing,
      classes("ts:src/x.ts#X", "ts:src/y.ts#X"),
      ["ts:src/x.ts#X", "ts:src/y.ts#X"],
    ],
    [
      "a member only one of them declares",
      "X.run",
      disagreeing,
      [
        ...classes("ts:src/x.ts#X", "ts:src/y.ts#X"),
        makeSymbol("ts:src/x.ts#X.run", { kind: "method" }),
      ],
      ["ts:src/x.ts#X", "ts:src/y.ts#X"],
    ],
    [
      "a member neither declares, though another class does",
      "X.run",
      disagreeing,
      [
        ...classes("ts:src/x.ts#X", "ts:src/y.ts#X"),
        makeSymbol("ts:src/z.ts#Z.run", { kind: "method" }),
      ],
      ["ts:src/x.ts#X", "ts:src/y.ts#X"],
    ],
    [
      "an export a drop rule removed against a kept one",
      "X",
      disagreeing,
      [
        makeSymbol("ts:src/x.ts#X", { derivedBy: ["export-keyword"], dropped: true }),
        makeSymbol("ts:src/y.ts#X", { derivedBy: ["export-keyword"] }),
      ],
      ["ts:src/y.ts#X"],
    ],
    [
      "a barrel that re-exports the conflict by name",
      "X",
      {
        "src/a.ts": [importing("./outer", "X")],
        "src/outer.ts": [reexportEdge("./barrel", "X")],
        "src/barrel.ts": [starReexportEdge("./x"), starReexportEdge("./y")],
      },
      classes("ts:src/x.ts#X", "ts:src/y.ts#X"),
      ["ts:src/x.ts#X", "ts:src/y.ts#X"],
    ],
    [
      "a namespace against a declaration",
      "X.f",
      {
        "src/a.ts": [importing("./barrel", "X")],
        "src/barrel.ts": [starReexportEdge("./spaces"), starReexportEdge("./y")],
        "src/spaces.ts": [namespaceReexportEdge("./m", "X")],
      },
      [...classes("ts:src/y.ts#X"), makeSymbol("ts:src/m.ts#f", { kind: "function" })],
      ["ts:src/y.ts#X"],
    ],
    [
      "two namespaces",
      "X.f",
      {
        "src/a.ts": [importing("./barrel", "X")],
        "src/barrel.ts": [starReexportEdge("./one"), starReexportEdge("./two")],
        "src/one.ts": [namespaceReexportEdge("./m", "X")],
        "src/two.ts": [namespaceReexportEdge("./n", "X")],
      },
      ["ts:src/m.ts#f", "ts:src/n.ts#f"].map((id) => makeSymbol(id, { kind: "function" })),
      [],
    ],
  ])(
    "leaves a name two star re-exports disagree on unresolved, `ambiguous`, for %s",
    (_label, target, modules, callees, candidates) => {
      const result = resolveThrough({ "src/a.ts": target }, modules, callees)
      expect(result.edges).toEqual([])
      expect(bucketsOf(result)).toEqual([["ambiguous", candidates]])
    },
  )

  it("takes no default export through a star re-export", () => {
    const result = resolveThrough(
      { "src/a.ts": "X" },
      {
        "src/a.ts": [importing("./barrel", "default as X")],
        "src/barrel.ts": [starReexportEdge("./x")],
      },
      classes("ts:src/x.ts#<default>"),
    )
    expect(result.edges).toEqual([])
    expect(bucketsOf(result)).toEqual([["no-match", []]])
  })

  it("asks each barrel once per search where every barrel re-exports every other", () => {
    const barrels = Array.from({ length: 12 }, (_, index) => `src/b${index}.ts`)
    const modules: Modules = Object.fromEntries([
      ["src/a.ts", [importing("./b0", "X", "Y")]],
      ...barrels.map((file, index) => [
        file,
        [
          ...barrels
            .filter((other) => other !== file)
            .map((other) => starReexportEdge(`./${other.slice(4, -3)}`)),
          ...(index === barrels.length - 1 ? [starReexportEdge("./x")] : []),
        ],
      ]),
    ])
    const calls = { "src/a.ts": "X" }
    const found = resolveThrough(calls, modules, classes("ts:src/x.ts#X"))
    expect(edgesOf(found)).toEqual([["ts:src/a.ts#caller", "ts:src/x.ts#X", "high"]])
    const missing = resolveThrough({ "src/a.ts": "Y" }, modules, classes("ts:src/x.ts#X"))
    expect(bucketsOf(missing)).toEqual([["no-match", []]])
  })

  it.each<[string, Modules]>([
    [
      "a named re-export of a package",
      {
        "src/a.ts": [importing("./barrel", "sortBy")],
        "src/barrel.ts": [reexportEdge("lodash", "sortBy")],
      },
    ],
    [
      "a star re-export of a package no other star re-export answers for",
      {
        "src/a.ts": [importing("./barrel", "sortBy")],
        "src/barrel.ts": [starReexportEdge("lodash"), starReexportEdge("./x")],
      },
    ],
  ])("buckets a chain that leaves the workspace through %s `external`", (_label, modules) => {
    const result = resolveThrough({ "src/a.ts": "sortBy" }, modules, classes("ts:src/x.ts#X"))
    expect(result.edges).toEqual([])
    expect(bucketsOf(result)).toEqual([["external", []]])
  })

  it.each<[string, Modules]>([
    [
      "barrels that re-export it from each other",
      {
        "src/a.ts": [importing("./one", "Logger")],
        "src/one.ts": [starReexportEdge("./two")],
        "src/two.ts": [reexportEdge("./one", "Logger")],
      },
    ],
    [
      "a relative specifier naming no file",
      {
        "src/a.ts": [importing("./barrel", "Logger")],
        "src/barrel.ts": [reexportEdge("./missing", "Logger")],
      },
    ],
    [
      "a module that exports another name",
      {
        "src/a.ts": [importing("./barrel", "Logger")],
        "src/barrel.ts": [reexportEdge("./x", "Other")],
      },
    ],
    [
      "a type-only re-export",
      {
        "src/a.ts": [importing("./barrel", "Logger")],
        "src/barrel.ts": [{ source: "./logger", symbols: ["Logger"] }],
      },
    ],
    [
      "`export type *`",
      {
        "src/a.ts": [importing("./barrel", "Logger")],
        "src/barrel.ts": [{ source: "./logger", symbols: "*" }],
      },
    ],
  ])("goes on to the Component through %s, which ends with no answer", (_label, modules) => {
    const callees = [
      ...classes("ts:src/logger.ts#Logger"),
      makeSymbol("ts:src/far.ts#Logger.log", { kind: "method", component: "billing" }),
    ]
    const bare = resolveThrough({ "src/a.ts": "Logger" }, modules, callees)
    expect(bare.edges).toEqual([])
    expect(bucketsOf(bare)).toEqual([["no-match", []]])
    const qualified = resolveThrough({ "src/a.ts": "Logger.log" }, modules, callees)
    expect(edgesOf(qualified)).toEqual([
      ["ts:src/a.ts#caller", "ts:src/far.ts#Logger.log", "medium"],
    ])
  })

  it("ends the search at a re-exported class that lacks the member", () => {
    const result = resolveThrough(
      { "src/a.ts": "Logger.log" },
      {
        "src/a.ts": [importing("./barrel", "Logger")],
        "src/barrel.ts": [starReexportEdge("./logger")],
      },
      [
        ...classes("ts:src/logger.ts#Logger"),
        makeSymbol("ts:src/far.ts#Logger.log", { kind: "method", component: "billing" }),
      ],
    )
    expect(result.edges).toEqual([])
    expect(bucketsOf(result)).toEqual([["no-match", []]])
  })
})

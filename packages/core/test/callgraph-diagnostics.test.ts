import { reexportEdge } from "@aburi/test-support"
import type { ImportEdge, Symbol as IRSymbol, Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey, makeSymbolCallKey } from "../src/call-site"
import { resolveCallGraph } from "../src/callgraph"
import { importsOf, params, withCalls } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

const NO_IMPORTS: ReadonlyMap<string, readonly ImportEdge[]> = new Map()

interface CallSetup {
  callees?: IRSymbol[]
  imports?: ReadonlyMap<string, readonly ImportEdge[]>
  signature?: Signature
  dynamicReceiver?: boolean
  /** Whether the language plugin found no scope around the call declaring its leading name. */
  unbound?: boolean
}

interface UnresolvedCase extends CallSetup {
  cause: string
  target: string
}

function resolveOneCall(target: string, setup: CallSetup = {}) {
  const caller = withCalls("ts:src/a.ts#caller", [{ target, line: 4 }], {
    component: "billing",
    signature: setup.signature ?? null,
  })
  const importsByFile = setup.imports ?? NO_IMPORTS
  return resolveCallGraph({
    symbols: [caller, ...(setup.callees ?? [])],
    importsByFile,
    moduleFiles: new Map([["ts", new Set(importsByFile.keys())]]),
    dynamicCallSites: new Set(
      setup.dynamicReceiver === true ? [makeCallSiteKey("src/a.ts", 4, target)] : [],
    ),
    unboundHeads: new Set(
      setup.unbound === true ? [makeSymbolCallKey("ts:src/a.ts#caller", 4, target)] : [],
    ),
  })
}

/** A member of that name elsewhere, so a call of it is one the workspace could hold. */
const namesake = (member: string): IRSymbol =>
  makeSymbol(`ts:src/other.ts#Other.${member}`, { kind: "method" })

/** A class `Heap` with a member `push`, which its file keeps to itself unless it exports it. */
const heap = (file: string, exported = false): IRSymbol[] => [
  makeSymbol(`ts:${file}#Heap`, { kind: "class", derivedBy: exported ? ["export-keyword"] : [] }),
  makeSymbol(`ts:${file}#Heap.push`, { kind: "method" }),
]

function competingSaves(): IRSymbol[] {
  return [
    makeSymbol("ts:src/z.ts#User.save", { kind: "method", component: "billing" }),
    makeSymbol("ts:src/b.ts#User.save", { kind: "method", component: "billing" }),
  ]
}

describe("unresolved calls are bucketed by cause", () => {
  it.each<UnresolvedCase>([
    { cause: "a callee that exists nowhere", target: "typoed" },
    {
      cause: "a relative import that misses",
      target: "helper",
      imports: importsOf("src/a.ts", { source: "./b", symbols: ["helper"] }),
    },
    {
      cause: "a `.` import that misses",
      target: "helper",
      imports: importsOf("src/a.ts", { source: ".", symbols: ["helper"] }),
    },
    {
      cause: "a dynamic import of a bare specifier",
      target: "sortBy",
      imports: importsOf("src/a.ts", { source: "lodash", symbols: ["sortBy"], dynamic: true }),
    },
  ])("`no-match` for $cause", (c) => {
    const result = resolveOneCall(c.target, c)
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
  })

  it("`no-match` for a `..` that climbs above the workspace root, rather than a clamp to the root index", () => {
    const caller = withCalls("ts:a.ts#caller", [{ target: "helper", line: 2 }])
    const result = resolveCallGraph({
      symbols: [caller, makeSymbol("ts:index.ts#helper")],
      importsByFile: importsOf("a.ts", { source: "..", symbols: ["helper"] }),
    })
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
  })

  it.each<UnresolvedCase>([
    {
      cause: "a named import",
      target: "sortBy",
      imports: importsOf("src/a.ts", { source: "lodash", symbols: ["sortBy"] }),
    },
    {
      cause: "a namespace import",
      target: "lodash.sortBy",
      imports: importsOf("src/a.ts", {
        source: "lodash",
        symbols: "*",
        namespaceBinding: "lodash",
      }),
    },
    {
      cause: "a default import, by its local binding",
      target: "React.createElement",
      imports: importsOf("src/a.ts", { source: "react", symbols: ["default as React"] }),
    },
    {
      cause: "an aliased import, by its local binding",
      target: "sort",
      imports: importsOf("src/a.ts", { source: "lodash", symbols: ["sortBy as sort"] }),
    },
  ])("`external` for $cause from a bare specifier", (c) => {
    const result = resolveOneCall(c.target, c)
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["external"])
  })

  it.each<UnresolvedCase & { candidates: string[] }>([
    {
      cause: "two top-level Symbols of that name in the caller's file",
      target: "helper",
      callees: [
        makeSymbol("ts:src/a.ts#helper.overload", { name: "helper" }),
        makeSymbol("ts:src/a.ts#helper"),
      ],
      candidates: ["ts:src/a.ts#helper", "ts:src/a.ts#helper.overload"],
    },
    {
      cause: "two imports binding that name",
      target: "helper",
      callees: [makeSymbol("ts:src/two.ts#helper"), makeSymbol("ts:src/one.ts#helper")],
      imports: importsOf(
        "src/a.ts",
        { source: "./two", symbols: ["helper"] },
        { source: "./one", symbols: ["helper"] },
      ),
      candidates: ["ts:src/one.ts#helper", "ts:src/two.ts#helper"],
    },
    {
      cause:
        "two default exports of the module a default import names, each with the member, over a same-named member in the caller's component",
      target: "U.save",
      callees: [
        makeSymbol("ts:src/x.ts#A", { kind: "class", derivedBy: ["export-default"] }),
        makeSymbol("ts:src/x.ts#A.save", { kind: "method" }),
        makeSymbol("ts:src/x.ts#B", { kind: "class", derivedBy: ["export-default"] }),
        makeSymbol("ts:src/x.ts#B.save", { kind: "method" }),
        makeSymbol("ts:src/z.ts#U.save", { kind: "method", component: "billing" }),
      ],
      imports: importsOf("src/a.ts", { source: "./x", symbols: ["default as U"] }),
      candidates: ["ts:src/x.ts#A.save", "ts:src/x.ts#B.save"],
    },
    {
      cause: "two Symbols of that name in the caller's component",
      target: "User.save",
      callees: competingSaves(),
      candidates: ["ts:src/b.ts#User.save", "ts:src/z.ts#User.save"],
    },
    {
      cause: "two Symbols of that name in other components",
      target: "User.save",
      callees: [
        makeSymbol("ts:src/z.ts#User.save", { kind: "method", component: "reporting" }),
        makeSymbol("ts:src/b.ts#User.save", { kind: "method", component: "analytics" }),
      ],
      candidates: ["ts:src/b.ts#User.save", "ts:src/z.ts#User.save"],
    },
  ])("`ambiguous`, never a silent pick, for $cause, with the candidates lex-sorted", (c) => {
    const result = resolveOneCall(c.target, c)
    expect(result.edges).toEqual([])
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics).toEqual([
      {
        symbolId: "ts:src/a.ts#caller",
        target: c.target,
        line: 4,
        bucket: "ambiguous",
        candidates: c.candidates,
      },
    ])
  })

  it.each<UnresolvedCase>([
    {
      cause: "a global's member",
      target: "console.log",
      callees: [namesake("log")],
      unbound: true,
    },
    { cause: "a global called by its name", target: "setTimeout", unbound: true },
    { cause: "a member nothing in the workspace names", target: "items.map" },
    { cause: "a member behind a non-null assertion nothing names", target: "items.map!" },
    { cause: "a function's `bind`, which calls nothing", target: "helper.bind" },
    {
      cause: "a member only a class another file keeps to itself declares",
      target: "items.push",
      callees: heap("src/heap.ts"),
    },
    {
      cause: "a member only a function another file keeps to itself is named",
      target: "parts.join",
      callees: [makeSymbol("ts:src/text.ts#join")],
    },
  ])("`external` for $cause, which no declaration the scan read can be", (c) => {
    const result = resolveOneCall(c.target, c)
    expect(result.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["external"])
  })

  it.each<UnresolvedCase & { bucket: string }>([
    {
      cause: "an unbound name a top-level declaration of the workspace has",
      target: "helper",
      callees: [makeSymbol("ts:src/script.ts#helper")],
      unbound: true,
      bucket: "no-match",
    },
    {
      cause: "an unbound name a top-level declaration has, of a member another class declares",
      target: "Pricing.calc",
      callees: [makeSymbol("ts:src/p.ts#Pricing", { kind: "class" }), namesake("calc")],
      unbound: true,
      bucket: "no-match",
    },
    {
      cause: "a member another class declares",
      target: "items.save",
      callees: [namesake("save")],
      bucket: "no-match",
    },
    {
      cause: "a member a dropped Symbol declares",
      target: "items.save",
      callees: [
        makeSymbol("ts:src/other.ts#Other.save", {
          kind: "method",
          dropped: true,
          dropReason: "cat-b:trivial",
        }),
      ],
      bucket: "no-match",
    },
    {
      cause: "a member an export clause names",
      target: "z.string",
      callees: [makeSymbol("ts:src/z.ts#stringType", { derivedBy: ["export-clause:string"] })],
      bucket: "no-match",
    },
    {
      cause: "a member a barrel re-exports under its name",
      target: "z.string",
      imports: new Map([["src/z.ts", [reexportEdge("./types", "stringType as string")]]]),
      bucket: "no-match",
    },
    {
      cause: "a member a class of the caller's file keeps to itself",
      target: "items.push",
      callees: heap("src/a.ts"),
      bucket: "no-match",
    },
    {
      cause: "a member a class keeps to a file the caller's file imports",
      target: "items.push",
      callees: heap("src/heap.ts"),
      imports: importsOf("src/a.ts", { source: "./heap", symbols: ["makeHeap"] }),
      bucket: "no-match",
    },
    {
      cause: "a member a class keeps to a file a barrel the caller's file imports re-exports",
      target: "items.push",
      callees: heap("src/heap.ts"),
      imports: new Map([
        ...importsOf("src/a.ts", { source: "./lib", symbols: ["makeHeap"] }),
        ["src/lib.ts", [reexportEdge("./heap", "makeHeap")]],
      ]),
      bucket: "no-match",
    },
    {
      cause: "a member of a class its file exports, which any module may be handed",
      target: "items.push",
      callees: heap("src/heap.ts", true),
      bucket: "no-match",
    },
    { cause: "a computed member", target: "items.<computed>", bucket: "no-match" },
    {
      cause: "an unbound name behind a non-null assertion that a top-level declaration has",
      target: "helper!",
      callees: [makeSymbol("ts:src/script.ts#helper")],
      unbound: true,
      bucket: "no-match",
    },
    {
      cause: "`this` a plugin marks unbound",
      target: "this.save",
      callees: [namesake("save")],
      unbound: true,
      bucket: "dynamic",
    },
    {
      cause: "`super` a plugin marks unbound",
      target: "super.save",
      callees: [namesake("save")],
      unbound: true,
      bucket: "dynamic",
    },
    { cause: "a function's `call`, which runs it", target: "helper.call", bucket: "no-match" },
    { cause: "a function's `apply`, which runs it", target: "helper.apply", bucket: "no-match" },
  ])("keeps $cause out of `external`, as one the workspace could hold", (c) => {
    expect(resolveOneCall(c.target, c).diagnostics.map((d) => d.bucket)).toEqual([c.bucket])
  })

  it("`dynamic` for an empty target", () => {
    expect(resolveOneCall("").diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })

  it("`dynamic` for an expression receiver, with nothing else about the call changed", () => {
    const callees = [namesake("save")]
    const plain = resolveOneCall("factory.save", { callees })
    const flagged = resolveOneCall("factory.save", { callees, dynamicReceiver: true })
    expect(flagged.symbols).toEqual(plain.symbols)
    expect(flagged.symbols[0]?.calls[0]?.resolved).toBeNull()
    expect(flagged.edges).toEqual([])
    expect(flagged.stats.resolvedCalls).toBe(plain.stats.resolvedCalls)
    expect(plain.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
    expect(flagged.diagnostics).toEqual([
      {
        symbolId: "ts:src/a.ts#caller",
        target: "factory.save",
        line: 4,
        bucket: "dynamic",
        candidates: [],
      },
    ])
  })

  it("leaves a call that resolves alone when its receiver is flagged as an expression", () => {
    const callees = [
      makeSymbol("ts:src/a.ts#helper", { kind: "class" }),
      makeSymbol("ts:src/a.ts#helper.save", { kind: "method" }),
    ]
    const plain = resolveOneCall("helper.save", { callees })
    const flagged = resolveOneCall("helper.save", { callees, dynamicReceiver: true })
    expect(flagged.edges).toEqual(plain.edges)
    expect(flagged.symbols).toEqual(plain.symbols)
    expect(flagged.diagnostics).toEqual([])
  })

  it.each<UnresolvedCase & { bucket: string; candidates: string[] }>([
    {
      cause: "`local-scope` over `external`, for a parameter named like an import",
      target: "sortBy",
      signature: params("sortBy"),
      imports: importsOf("src/a.ts", { source: "lodash", symbols: ["sortBy"] }),
      bucket: "local-scope",
      candidates: [],
    },
    {
      cause: "`local-scope` over `dynamic`, for a parameter used as an expression receiver",
      target: "factory.save",
      signature: params("factory"),
      dynamicReceiver: true,
      bucket: "local-scope",
      candidates: [],
    },
    {
      cause: "`dynamic` over `ambiguous`, since an expression receiver was never resolvable",
      target: "User.save",
      callees: competingSaves(),
      dynamicReceiver: true,
      bucket: "dynamic",
      candidates: [],
    },
    {
      cause: "`external` over `dynamic`, for an expression receiver whose head a package binds",
      target: "repo.save",
      callees: [namesake("save")],
      imports: importsOf("src/a.ts", { source: "@acme/db", symbols: ["repo"] }),
      dynamicReceiver: true,
      bucket: "external",
      candidates: [],
    },
    {
      cause: "`external` over `ambiguous`, since the import binds the name the namesakes spell",
      target: "User.save",
      callees: competingSaves(),
      imports: importsOf("src/a.ts", { source: "@acme/models", symbols: ["User"] }),
      bucket: "external",
      candidates: [],
    },
    {
      cause: "`external` over `dynamic`, for a global's call the receiver is",
      target: "expect.toBe",
      callees: [namesake("toBe")],
      dynamicReceiver: true,
      unbound: true,
      bucket: "external",
      candidates: [],
    },
    {
      cause: "`external` over `dynamic`, for a member of `this` nothing declares",
      target: "this.emit",
      bucket: "external",
      candidates: [],
    },
    {
      cause: "`local-scope` over `external`, for a member of a parameter nothing declares",
      target: "res.json",
      signature: params("res"),
      bucket: "local-scope",
      candidates: [],
    },
  ])("prefers $cause", (c) => {
    expect(resolveOneCall(c.target, c).diagnostics.map((d) => [d.bucket, d.candidates])).toEqual([
      [c.bucket, c.candidates],
    ])
  })

  it("counts every call site in stats, and each unresolved one in its bucket", () => {
    const caller = makeSymbol("ts:src/a.ts#caller", {
      signature: params("shadowed"),
      calls: [
        { target: "helper", line: 1, resolved: null },
        { target: "shadowed", line: 2, resolved: null },
        { target: "this.save", line: 3, resolved: null },
        { target: "typoed", line: 4, resolved: null },
        { target: "this.emit", line: 5, resolved: null },
      ],
    })
    const helper = makeSymbol("ts:src/a.ts#helper")
    const result = resolveCallGraph({
      symbols: [caller, helper, namesake("save")],
      importsByFile: NO_IMPORTS,
    })
    expect(result.stats).toEqual({
      totalCalls: 5,
      resolvedCalls: 1,
      unresolved: { localScope: 1, external: 1, dynamic: 1, ambiguous: 0, noMatch: 1 },
    })
  })

  it("counts the calls of a dropped Symbol too", () => {
    const dropped = withCalls("ts:src/a.ts#gone", [{ target: "typoed", line: 1 }], {
      dropped: true,
      dropReason: "cat-b:trivial",
    })
    const result = resolveCallGraph({ symbols: [dropped], importsByFile: NO_IMPORTS })
    expect(result.stats.totalCalls).toBe(1)
    expect(result.stats.unresolved.noMatch).toBe(1)
  })

  it("sorts diagnostics by (symbolId, line, target) whatever order the Symbols arrive in", () => {
    const late = withCalls("ts:src/z.ts#zeta", [{ target: "nope", line: 1 }])
    const early = withCalls("ts:src/a.ts#alpha", [
      { target: "b-nope", line: 9 },
      { target: "a-nope", line: 2 },
    ])
    const forward = resolveCallGraph({ symbols: [late, early], importsByFile: NO_IMPORTS })
    const reversed = resolveCallGraph({ symbols: [early, late], importsByFile: NO_IMPORTS })
    expect(forward.diagnostics.map((d) => `${d.symbolId}:${d.line}:${d.target}`)).toEqual([
      "ts:src/a.ts#alpha:2:a-nope",
      "ts:src/a.ts#alpha:9:b-nope",
      "ts:src/z.ts#zeta:1:nope",
    ])
    expect(reversed.diagnostics).toEqual(forward.diagnostics)
  })
})

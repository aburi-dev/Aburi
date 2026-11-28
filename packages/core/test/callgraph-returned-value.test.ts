import { symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol, UnresolvedCallBucket } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey, makeSymbolCallKey, type ReturnSource } from "../src/call-site"
import { resolveCallGraph } from "../src/callgraph"
import { type ImportClause, importsOf, withCalls } from "./fixtures/callgraph"
import { makeSymbol, type SymbolOverrides } from "./fixtures/ir"

const CALLER = "ts:src/use.ts#main"
const MAKE = "ts:src/make.ts#make"
const BUILD = "ts:src/make.ts#build"
const FACTORY_MAKE = "ts:src/make.ts#Factory.make"
const RUN = "ts:src/box.ts#Box.run"
const FROM_MAKE: ImportClause = { source: "./make", symbols: ["make"] }
const FROM_BOX: ImportClause = { source: "./box", symbols: ["Box"] }

/** A call `main` writes: its target, its line, and the call its receiver is the result of. */
type WrittenCall = readonly [target: string, line: number, receiver?: readonly [string, number]]

interface Setup {
  calls?: readonly WrittenCall[]
  caller?: SymbolOverrides
  make?: SymbolOverrides
  returns?: ReadonlyArray<readonly [id: string, source: ReturnSource]>
  symbols?: readonly IRSymbol[]
  imports?: ImportClause[]
  /** What `src/make.ts` imports. */
  makeImports?: ImportClause[]
  /** By target: the Symbol a call `main` writes was resolved to before the resolver ran. */
  resolvedBefore?: Readonly<Record<string, string>>
}

const box = [
  makeSymbol("ts:src/box.ts#Box", { kind: "class", derivedBy: ["export-keyword"] }),
  makeSymbol(RUN, { kind: "method" }),
  makeSymbol("ts:src/box.ts#Box.with", { kind: "method" }),
]

// `main` writes `make().run()` on line 2; `src/make.ts` imports `Box` from `./box`.
function resolve(setup: Setup = {}) {
  const calls = setup.calls ?? [
    ["make", 2],
    ["make.run", 2, ["make", 2]],
  ]
  return resolveCallGraph({
    symbols: [
      makeSymbol(CALLER, {
        calls: calls.map(([target, line]) => {
          const before = setup.resolvedBefore?.[target]
          return { target, line, resolved: before === undefined ? null : symbolId(before) }
        }),
        ...setup.caller,
      }),
      makeSymbol(MAKE, { kind: "function", ...setup.make }),
      ...box,
      ...(setup.symbols ?? []),
    ],
    importsByFile: new Map([
      ...importsOf("src/use.ts", ...(setup.imports ?? [FROM_MAKE])),
      ...importsOf("src/make.ts", ...(setup.makeImports ?? [FROM_BOX])),
    ]),
    returnSources: new Map(
      (setup.returns ?? [[MAKE, { type: "Box" }]]).map(([id, source]) => [symbolId(id), source]),
    ),
    // The plugin marks a receiver that is a call's result as an expression.
    dynamicCallSites: new Set(
      calls.flatMap(([target, line, receiver]) =>
        receiver === undefined ? [] : [makeCallSiteKey("src/use.ts", line, target)],
      ),
    ),
    receiverCalls: new Map(
      calls.flatMap(([target, line, receiver]) =>
        receiver === undefined
          ? []
          : [
              [
                makeSymbolCallKey(CALLER, line, target),
                makeCallSiteKey("src/use.ts", receiver[1], receiver[0]),
              ],
            ],
      ),
    ),
  })
}

const resolvedTo = (result: ReturnType<typeof resolve>, target: string) => ({
  resolved: result.symbols[0]?.calls.find((call) => call.target === target)?.resolved,
  confidence: result.edges.find((edge) => edge.from === CALLER && edge.to.endsWith(".run"))
    ?.confidence,
})

describe("a call through what another call gave back", () => {
  it.each<[string, Setup, string]>([
    ["a class the callee names, bound where the callee is declared", {}, "make.run"],
    [
      "the call the callee returns",
      {
        make: { calls: [{ target: "build", line: 5, resolved: null }] },
        returns: [
          [MAKE, { callSite: makeCallSiteKey("src/make.ts", 5, "build") }],
          [BUILD, { type: "Box" }],
        ],
        symbols: [makeSymbol(BUILD, { kind: "function" })],
      },
      "make.run",
    ],
    [
      "the function a variable names",
      {
        make: { kind: "const" },
        returns: [
          [MAKE, { reference: "build" }],
          [BUILD, { type: "Box" }],
        ],
        symbols: [makeSymbol(BUILD, { kind: "function" })],
      },
      "make.run",
    ],
    [
      "a chain, each link the class the one before it gives back",
      {
        calls: [
          ["make", 2],
          ["make.with", 2, ["make", 2]],
          ["make.with.run", 2, ["make.with", 2]],
        ],
        returns: [
          [MAKE, { type: "Box" }],
          ["ts:src/box.ts#Box.with", { type: "Box" }],
        ],
      },
      "make.with.run",
    ],
    [
      "a method that gives back `this`, its receiver the class the call before it gives back",
      {
        calls: [
          ["make", 2],
          ["make.with", 2, ["make", 2]],
          ["make.with.run", 2, ["make.with", 2]],
        ],
        returns: [
          [MAKE, { type: "Box" }],
          ["ts:src/box.ts#Box.with", { self: true }],
        ],
      },
      "make.with.run",
    ],
    [
      "a receiver call resolved before the resolver ran",
      { resolvedBefore: { make: MAKE } },
      "make.run",
    ],
  ])("resolves to the class's member, through %s, at medium confidence", (_c, setup, target) => {
    expect(resolvedTo(resolve(setup), target)).toEqual({ resolved: RUN, confidence: "medium" })
  })

  it.each<[string, Setup, UnresolvedCallBucket]>([
    ["a callee that names nothing it gives back", { returns: [] }, "dynamic"],
    [
      "a type the callee's file binds to no class",
      { returns: [[MAKE, { type: "Missing" }]] },
      "dynamic",
    ],
    [
      "a type only the caller's file binds",
      { imports: [FROM_MAKE, FROM_BOX], makeImports: [] },
      "dynamic",
    ],
    [
      "a member the class does not declare",
      {
        calls: [
          ["make", 2],
          ["make.stop", 2, ["make", 2]],
        ],
      },
      "external",
    ],
    [
      "two calls written alike on one line, either of which the receiver may be",
      {
        calls: [
          ["make", 2],
          ["make", 2],
          ["make.run", 2, ["make", 2]],
        ],
      },
      "dynamic",
    ],
    [
      "a callee whose return comes round to itself",
      {
        make: { calls: [{ target: "make", line: 5, resolved: null }] },
        returns: [[MAKE, { callSite: makeCallSiteKey("src/make.ts", 5, "make") }]],
      },
      "dynamic",
    ],
    [
      "a callee that gives back `this`, called on no receiver",
      { returns: [[MAKE, { self: true }]] },
      "dynamic",
    ],
    [
      "a variable naming a function that gives back `this`",
      {
        make: { kind: "const" },
        returns: [
          [MAKE, { reference: "build" }],
          [BUILD, { self: true }],
        ],
        symbols: [makeSymbol(BUILD, { kind: "function" })],
      },
      "dynamic",
    ],
  ])("leaves the call unresolved, bucketed as before, for %s", (_case, setup, bucket) => {
    const result = resolve(setup)
    const outer = (target: string) => target.endsWith(".run") || target.endsWith(".stop")
    expect(result.symbols[0]?.calls.find((c) => outer(c.target))?.resolved).toBeNull()
    expect(result.diagnostics.filter((d) => outer(d.target)).map((d) => d.bucket)).toEqual([bucket])
  })

  it("leaves the call unresolved through a callee found only by its name, in another component", () => {
    const result = resolve({
      calls: [
        ["Factory.make", 2],
        ["Factory.make.run", 2, ["Factory.make", 2]],
      ],
      caller: { component: "billing" },
      returns: [[FACTORY_MAKE, { type: "Box" }]],
      symbols: [makeSymbol(FACTORY_MAKE, { kind: "method", component: "api" })],
    })
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([[FACTORY_MAKE, "low"]])
    expect(result.symbols[0]?.calls.map((call) => call.resolved)).toEqual([FACTORY_MAKE, null])
  })

  it("leaves receivers unresolved that each name the other's call", () => {
    const result = resolveCallGraph({
      symbols: [
        withCalls(CALLER, [
          { target: "a.run", line: 2 },
          { target: "b.run", line: 3 },
        ]),
      ],
      importsByFile: new Map(),
      receiverCalls: new Map([
        [makeSymbolCallKey(CALLER, 2, "a.run"), makeCallSiteKey("src/use.ts", 3, "b.run")],
        [makeSymbolCallKey(CALLER, 3, "b.run"), makeCallSiteKey("src/use.ts", 2, "a.run")],
      ]),
      returnSources: new Map(),
    })
    expect(result.symbols[0]?.calls.map((call) => call.resolved)).toEqual([null, null])
  })
})

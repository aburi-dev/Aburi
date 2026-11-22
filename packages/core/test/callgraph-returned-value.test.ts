import { symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
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
}

const box = [
  makeSymbol("ts:src/box.ts#Box", { kind: "class" }),
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
      withCalls(
        CALLER,
        calls.map(([target, line]) => ({ target, line })),
        setup.caller,
      ),
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
  ])("resolves to the class's member, through %s, at medium confidence", (_c, setup, target) => {
    expect(resolvedTo(resolve(setup), target)).toEqual({ resolved: RUN, confidence: "medium" })
  })

  it.each<[string, Setup]>([
    ["a callee that names nothing it gives back", { returns: [] }],
    ["a type the callee's file binds to no class", { returns: [[MAKE, { type: "Missing" }]] }],
    ["a type only the caller's file binds", { imports: [FROM_MAKE, FROM_BOX], makeImports: [] }],
    [
      "a member the class does not declare",
      {
        calls: [
          ["make", 2],
          ["make.stop", 2, ["make", 2]],
        ],
      },
    ],
    [
      "a callee found only by its name, in another component",
      {
        calls: [
          ["Factory.make", 2],
          ["Factory.make.run", 2, ["Factory.make", 2]],
        ],
        caller: { component: "billing" },
        returns: [[FACTORY_MAKE, { type: "Box" }]],
        symbols: [makeSymbol(FACTORY_MAKE, { kind: "method", component: "api" })],
      },
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
    ],
    [
      "a callee whose return comes round to itself",
      {
        make: { calls: [{ target: "make", line: 5, resolved: null }] },
        returns: [[MAKE, { callSite: makeCallSiteKey("src/make.ts", 5, "make") }]],
      },
    ],
  ])("leaves the call unresolved for %s", (_case, setup) => {
    const result = resolve(setup)
    const call = result.symbols[0]?.calls.find(
      (c) => c.target.endsWith(".run") || c.target.endsWith(".stop"),
    )
    expect(call?.resolved).toBeNull()
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

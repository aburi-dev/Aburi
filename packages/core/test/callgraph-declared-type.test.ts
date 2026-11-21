import { importEdge, starReexportEdge, symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey, makeSymbolCallKey } from "../src/call-site"
import { type ResolveCallGraphInput, resolveCallGraph } from "../src/callgraph"
import { edgesOf, type ImportClause, importsOf, withCalls } from "./fixtures/callgraph"
import { makeSymbol, type SymbolOverrides } from "./fixtures/ir"

const CALLER = "ts:src/service.ts#UserService.byId"
const TARGET = "this.repo.find"

const repository = (file = "src/repo.ts", overrides: SymbolOverrides = {}) => [
  makeSymbol(`ts:${file}#UserRepository`, { kind: "class", ...overrides }),
  makeSymbol(`ts:${file}#UserRepository.find`, { kind: "method" }),
]

const typed = (type: string, target = TARGET) =>
  new Map([[makeSymbolCallKey(CALLER, 3, target), type]])

function resolve(
  symbols: readonly IRSymbol[],
  options: Partial<ResolveCallGraphInput> & { imports?: ImportClause[] } = {},
) {
  const { imports = [], ...input } = options
  return resolveCallGraph({
    symbols: [withCalls(CALLER, [{ target: TARGET, line: 3 }]), ...symbols],
    importsByFile: importsOf("src/service.ts", ...imports),
    declaredReceiverTypes: typed("UserRepository"),
    ...input,
  })
}

const FROM_REPO: ImportClause = { source: "./repo", symbols: ["UserRepository"] }

describe("a call through a receiver of a declared type", () => {
  it.each<[string, readonly IRSymbol[], ImportClause[], string]>([
    ["a class the file imports", repository(), [FROM_REPO], "UserRepository"],
    ["a class the file declares", repository("src/service.ts"), [], "UserRepository"],
    [
      "a class imported under another name",
      repository(),
      [{ source: "./repo", symbols: ["UserRepository as Repo"] }],
      "Repo",
    ],
    [
      "a class a default import names",
      repository("src/repo.ts", { derivedBy: ["export-default"] }),
      [{ source: "./repo", symbols: ["default as Repo"] }],
      "Repo",
    ],
    [
      "a class of a namespace the file imports",
      repository(),
      [{ source: "./repo", symbols: "*", namespaceBinding: "repos" }],
      "repos.UserRepository",
    ],
  ])("resolves to the member of %s, at medium confidence", (_case, symbols, imports, type) => {
    const result = resolve(symbols, { imports, declaredReceiverTypes: typed(type) })
    const find = symbols[1]?.id
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([[find, "medium"]])
    expect(result.symbols[0]?.calls[0]?.resolved).toBe(find)
    expect(result.diagnostics).toEqual([])
  })

  it("resolves to the member of a class a barrel re-exports", () => {
    const symbols = repository("src/data/repo.ts")
    const result = resolve(symbols, {
      importsByFile: new Map([
        ["src/service.ts", [importEdge({ source: "./data", symbols: ["UserRepository"] })]],
        ["src/data/index.ts", [starReexportEdge("./repo")]],
      ]),
      moduleFiles: new Map([["ts", new Set(["src/data/index.ts"])]]),
    })
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([
      [symbols[1]?.id, "medium"],
    ])
  })

  it("reads the type's instance member, not a static one of the same name", () => {
    const result = resolve(
      [...repository(), makeSymbol("ts:src/repo.ts#UserRepository::find", { kind: "method" })],
      { imports: [FROM_REPO] },
    )
    expect(result.edges.map((edge) => edge.to)).toEqual(["ts:src/repo.ts#UserRepository.find"])
  })

  it.each<[string, readonly IRSymbol[], ImportClause[], ReadonlyMap<string, string>]>([
    [
      "an interface, which a class implements elsewhere",
      repository("src/repo.ts", { kind: "interface" }),
      [FROM_REPO],
      typed("UserRepository"),
    ],
    [
      "a class that does not declare the member itself",
      [makeSymbol("ts:src/repo.ts#UserRepository", { kind: "class" })],
      [FROM_REPO],
      typed("UserRepository"),
    ],
    [
      "a class the file neither declares nor imports, though another file declares it",
      repository(),
      [],
      typed("UserRepository"),
    ],
    ["no type at all", repository(), [FROM_REPO], new Map()],
  ])("leaves the call unresolved and `dynamic` for %s", (_case, symbols, imports, types) => {
    const result = resolve(symbols, { imports, declaredReceiverTypes: types })
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })

  it.each([
    ["one that names a subclass's override", "this", "ts:src/repo.ts#AdminRepository.find"],
    ["one whose receiver kind is not the call's", "super", "ts:src/repo.ts#AdminRepository.find"],
    ["one naming a dropped Symbol", "this", "ts:src/repo.ts#Dropped.find"],
  ] as const)("leaves a language server's hint unread, %s", (_case, kind, hinted) => {
    const result = resolve(
      [
        ...repository(),
        makeSymbol("ts:src/repo.ts#AdminRepository.find", { kind: "method" }),
        makeSymbol("ts:src/repo.ts#Dropped.find", {
          kind: "method",
          dropped: true,
          dropReason: "cat-b:trivial",
        }),
      ],
      {
        imports: [FROM_REPO],
        receiverHints: new Map([
          [
            makeCallSiteKey("src/service.ts", 3, TARGET),
            { kind, targetSymbolId: symbolId(hinted) },
          ],
        ]),
      },
    )
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([
      ["ts:src/repo.ts#UserRepository.find", "medium"],
    ])
    expect(result.lspHintUsage).toEqual({ consumed: 0, kindMismatch: 0, targetDropped: 0 })
    expect(result.diagnostics).toEqual([])
  })

  it("leaves a call the earlier steps resolved as they resolved it", () => {
    const result = resolveCallGraph({
      symbols: [
        withCalls(CALLER, [{ target: "repo.find", line: 3 }]),
        ...repository(),
        makeSymbol("ts:src/service.ts#repo", { kind: "variable" }),
        makeSymbol("ts:src/service.ts#repo.find", { kind: "method" }),
      ],
      importsByFile: importsOf("src/service.ts", FROM_REPO),
      declaredReceiverTypes: typed("UserRepository", "repo.find"),
    })
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([
      ["ts:src/service.ts#repo.find", "high"],
    ])
  })
})

describe("a call of a member of `this`, whose type is the caller's own class", () => {
  const OWN = "ts:src/service.ts#UserService.load"
  const BASE = "ts:src/base.ts#BaseService.load"
  const service = [
    makeSymbol("ts:src/service.ts#UserService", { kind: "class" }),
    makeSymbol(OWN, { kind: "method" }),
  ]

  function resolveThis(
    symbols: readonly IRSymbol[],
    hint?: { kind: "this" | "super"; to: string },
  ) {
    const target = "this.load"
    return resolveCallGraph({
      symbols: [
        withCalls(CALLER, [{ target, line: 3 }]),
        ...symbols,
        makeSymbol(BASE, { kind: "method" }),
        makeSymbol("ts:src/base.ts#Dropped.load", {
          kind: "method",
          dropped: true,
          dropReason: "cat-b:trivial",
        }),
      ],
      importsByFile: importsOf("src/service.ts"),
      declaredReceiverTypes: typed("UserService", target),
      receiverHints:
        hint === undefined
          ? new Map()
          : new Map([
              [
                makeCallSiteKey("src/service.ts", 3, target),
                { kind: hint.kind, targetSymbolId: symbolId(hint.to) },
              ],
            ]),
    })
  }

  it("resolves to the member the class declares, at medium confidence", () => {
    const result = resolveThis(service)
    expect(edgesOf(result)).toEqual([[CALLER, OWN, "medium"]])
    expect(result.diagnostics).toEqual([])
  })

  it("takes a language server's hint first, which reads the members the class inherits", () => {
    const result = resolveThis(service, { kind: "this", to: BASE })
    expect(edgesOf(result)).toEqual([[CALLER, BASE, "high"]])
    expect(result.lspHintUsage).toEqual({ consumed: 1, kindMismatch: 0, targetDropped: 0 })
  })

  it.each([
    ["names another receiver kind", "super", BASE, { kindMismatch: 1, targetDropped: 0 }],
    [
      "names a dropped Symbol",
      "this",
      "ts:src/base.ts#Dropped.load",
      { kindMismatch: 0, targetDropped: 1 },
    ],
  ] as const)("reads the class's own member when the hint %s", (_case, kind, to, rejected) => {
    const result = resolveThis(service, { kind, to })
    expect(edgesOf(result)).toEqual([[CALLER, OWN, "medium"]])
    expect(result.lspHintUsage).toEqual({ consumed: 0, ...rejected })
  })

  it("leaves a member the class only inherits unresolved without a hint", () => {
    const result = resolveThis(service.slice(0, 1))
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })
})

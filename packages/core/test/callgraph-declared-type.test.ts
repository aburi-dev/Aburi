import { importEdge, starReexportEdge, symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { type ClassHeritages, makeCallSiteKey, makeSymbolCallKey } from "../src/call-site"
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

/** A class's id, the name its `extends` writes, and the instance members it declares itself. */
type Heritage = readonly [classId: string, superclass: string, instanceMembers?: string[]]

const heritagesOf = (heritages: readonly Heritage[]): ClassHeritages =>
  new Map(
    heritages.map(([id, superclass, instanceMembers = []]) => [
      symbolId(id),
      { superclass, instanceMembers },
    ]),
  )

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
    input: Partial<ResolveCallGraphInput> = {},
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
      ...input,
    })
  }

  const MIXIN = "ts:src/mixin.ts#Audited.load"
  // `UserService extends BaseService`, which its file imports, and declares no `load` itself.
  const resolveInherited = (hint?: { kind: "this" | "super"; to: string }) =>
    resolveThis(
      [
        ...service.slice(0, 1),
        makeSymbol("ts:src/base.ts#BaseService", { kind: "class" }),
        makeSymbol(MIXIN, { kind: "method" }),
      ],
      hint,
      {
        importsByFile: importsOf("src/service.ts", { source: "./base", symbols: ["BaseService"] }),
        classHeritages: heritagesOf([["ts:src/service.ts#UserService", "BaseService"]]),
      },
    )

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

  it("resolves to a member the class inherits from the class it extends, at medium confidence", () => {
    const result = resolveInherited()
    expect(edgesOf(result)).toEqual([[CALLER, BASE, "medium"]])
    expect(result.diagnostics).toEqual([])
  })

  it("takes a language server's hint over a member the class inherits", () => {
    const result = resolveInherited({ kind: "this", to: MIXIN })
    expect(edgesOf(result)).toEqual([[CALLER, MIXIN, "high"]])
    expect(result.lspHintUsage).toEqual({ consumed: 1, kindMismatch: 0, targetDropped: 0 })
  })

  it.each([
    ["names another receiver kind", "super", MIXIN, { kindMismatch: 1, targetDropped: 0 }],
    [
      "names a dropped Symbol",
      "this",
      "ts:src/base.ts#Dropped.load",
      { kindMismatch: 0, targetDropped: 1 },
    ],
  ] as const)(
    "reads the member the class inherits when the hint %s",
    (_case, kind, to, rejected) => {
      const result = resolveInherited({ kind, to })
      expect(edgesOf(result)).toEqual([[CALLER, BASE, "medium"]])
      expect(result.lspHintUsage).toEqual({ consumed: 0, ...rejected })
    },
  )

  it("leaves a member the class only inherits unresolved without a hint, when it extends no class", () => {
    const result = resolveThis(service.slice(0, 1))
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })
})

describe("a call through a receiver of a declared type, to a member its class inherits", () => {
  const USER = "ts:src/repo.ts#UserRepository"
  const MIDDLE = "ts:src/repo.ts#Middle"
  const BASE = "ts:src/base.ts#BaseRepository"
  const classes = (...ids: string[]) => ids.map((id) => makeSymbol(id, { kind: "class" }))
  const method = (id: string, overrides: SymbolOverrides = {}) =>
    makeSymbol(id, { kind: "method", ...overrides })
  const FROM_BASE: ImportClause = { source: "./base", symbols: ["BaseRepository"] }

  function resolveInherited(
    symbols: readonly IRSymbol[],
    heritages: readonly Heritage[],
    imports: { service?: ImportClause[]; repo?: ImportClause[] } = {},
  ) {
    return resolve(symbols, {
      importsByFile: new Map([
        ["src/service.ts", [FROM_REPO, ...(imports.service ?? [])].map(importEdge)],
        ["src/repo.ts", (imports.repo ?? []).map(importEdge)],
      ]),
      classHeritages: heritagesOf(heritages),
    })
  }

  it.each<[string, readonly IRSymbol[], readonly Heritage[], string]>([
    [
      "the class its file imports and extends",
      [...classes(USER, BASE), method(`${BASE}.find`)],
      [[USER, "BaseRepository"]],
      `${BASE}.find`,
    ],
    [
      "a class two levels up",
      [...classes(USER, MIDDLE, BASE), method(`${BASE}.find`)],
      [
        [USER, "Middle"],
        [MIDDLE, "BaseRepository"],
      ],
      `${BASE}.find`,
    ],
    [
      "the nearest class that declares it",
      [...classes(USER, MIDDLE, BASE), method(`${MIDDLE}.find`), method(`${BASE}.find`)],
      [
        [USER, "Middle"],
        [MIDDLE, "BaseRepository"],
      ],
      `${MIDDLE}.find`,
    ],
    [
      "a class past one a drop rule removed",
      [
        ...classes(USER, BASE),
        makeSymbol(MIDDLE, { kind: "class", dropped: true, dropReason: "pure DTO" }),
        method(`${BASE}.find`),
      ],
      [
        [USER, "Middle"],
        [MIDDLE, "BaseRepository", ["table"]],
      ],
      `${BASE}.find`,
    ],
    [
      "the class a dropped class extends, the receiver's own",
      [
        makeSymbol(USER, { kind: "class", dropped: true, dropReason: "pure DTO" }),
        ...classes(BASE),
        method(`${BASE}.find`),
      ],
      [[USER, "BaseRepository", ["table"]]],
      `${BASE}.find`,
    ],
  ])("resolves to the member of %s, at medium confidence", (_case, symbols, heritages, to) => {
    const result = resolveInherited(symbols, heritages, { repo: [FROM_BASE] })
    expect(edgesOf(result)).toEqual([[CALLER, to, "medium"]])
    expect(result.diagnostics).toEqual([])
  })

  it.each<
    [
      string,
      readonly IRSymbol[],
      readonly Heritage[],
      { service?: ImportClause[]; repo?: ImportClause[] },
    ]
  >([
    [
      "a member the class declares, though a drop rule removed it",
      [
        ...classes(USER, BASE),
        method(`${USER}.find`, { dropped: true, dropReason: "empty body" }),
        method(`${BASE}.find`),
      ],
      [[USER, "BaseRepository"]],
      { repo: [FROM_BASE] },
    ],
    [
      "a member the class declares with no Symbol, as a field holding data",
      [...classes(USER, BASE), method(`${BASE}.find`)],
      [[USER, "BaseRepository", ["find"]]],
      { repo: [FROM_BASE] },
    ],
    [
      "a superclass the caller's file binds and the class's does not",
      [...classes(USER, BASE), method(`${BASE}.find`)],
      [[USER, "BaseRepository"]],
      { service: [FROM_BASE] },
    ],
    [
      "a superclass name that binds no class",
      [makeSymbol(BASE, { kind: "function" }), ...classes(USER), method(`${BASE}.find`)],
      [[USER, "BaseRepository"]],
      { repo: [FROM_BASE] },
    ],
    [
      "classes that extend each other",
      classes(USER, MIDDLE),
      [
        [USER, "Middle"],
        [MIDDLE, "UserRepository"],
      ],
      {},
    ],
  ])("leaves the call unresolved and `dynamic` for %s", (_case, symbols, heritages, imports) => {
    const result = resolveInherited(symbols, heritages, imports)
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })
})

describe("a call through `super`, whose type is the class the caller's class extends", () => {
  const ADMIN = "ts:src/admin.ts#AdminService"
  const MIDDLE = "ts:src/admin.ts#Middle"
  const BASE = "ts:src/base.ts#BaseService"
  const CONSTRUCTOR = `${ADMIN}.constructor`
  const SAVE = `${ADMIN}.save`
  const classes = (...ids: string[]) => ids.map((id) => makeSymbol(id, { kind: "class" }))
  const method = (id: string, overrides: SymbolOverrides = {}) =>
    makeSymbol(id, { kind: "method", ...overrides })

  // `AdminService extends BaseService`, which its file imports; the plugin types `super` with it.
  function resolveSuper(
    symbols: readonly IRSymbol[],
    heritages: readonly Heritage[] = [[ADMIN, "BaseService"]],
    { target = "super.save", type = "BaseService" }: { target?: string; type?: string } = {},
  ) {
    const caller = target === "super" ? CONSTRUCTOR : SAVE
    return resolveCallGraph({
      symbols: [withCalls(caller, [{ target, line: 3 }]), ...symbols],
      importsByFile: importsOf("src/admin.ts", { source: "./base", symbols: ["BaseService"] }),
      declaredReceiverTypes: new Map([[makeSymbolCallKey(caller, 3, target), type]]),
      classHeritages: heritagesOf(heritages),
    })
  }

  it("resolves `super(…)` to the class, at high confidence", () => {
    const result = resolveSuper(classes(ADMIN, BASE), undefined, { target: "super" })
    expect(edgesOf(result)).toEqual([[CONSTRUCTOR, BASE, "high"]])
    expect(result.diagnostics).toEqual([])
  })

  it.each<[string, readonly IRSymbol[], readonly Heritage[], string]>([
    [
      "the class extends",
      [...classes(ADMIN, BASE), method(`${BASE}.save`), method(SAVE)],
      [[ADMIN, "BaseService"]],
      `${BASE}.save`,
    ],
    [
      "the nearest class up the chain that declares it",
      [...classes(ADMIN, MIDDLE, BASE), method(`${BASE}.save`)],
      [
        [ADMIN, "Middle"],
        [MIDDLE, "BaseService"],
      ],
      `${BASE}.save`,
    ],
  ])(
    "resolves `super.<member>` to the member %s, at high confidence",
    (_c, symbols, heritages, to) => {
      const type = heritages[0]?.[1]
      const result = resolveSuper(symbols, heritages, type === undefined ? {} : { type })
      expect(edgesOf(result)).toEqual([[SAVE, to, "high"]])
      expect(result.diagnostics).toEqual([])
    },
  )

  it.each<[string, readonly IRSymbol[], readonly Heritage[], { target?: string; type?: string }]>([
    [
      "`super(…)` of a class a drop rule removed",
      [makeSymbol(BASE, { kind: "class", dropped: true, dropReason: "pure DTO" })],
      [],
      { target: "super" },
    ],
    [
      "a member the class declares, though a drop rule removed it",
      [...classes(BASE), method(`${BASE}.save`, { dropped: true, dropReason: "empty body" })],
      [],
      {},
    ],
    [
      "a member the class holds in a field, which is no member of its prototype",
      [
        ...classes(BASE),
        method(`${BASE}.save`, { derivedBy: ["class-method", "field-assigned-function"] }),
      ],
      [],
      {},
    ],
    [
      "a member the class declares with no Symbol",
      [...classes(MIDDLE, BASE), method(`${BASE}.save`)],
      [[MIDDLE, "BaseService", ["save"]]],
      { type: "Middle" },
    ],
    [
      "a member of a member",
      [...classes(BASE), method(`${BASE}.repo`)],
      [],
      { target: "super.repo.save" },
    ],
  ])("leaves %s unresolved and `dynamic`", (_case, symbols, heritages, call) => {
    const result = resolveSuper(symbols, heritages, call)
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })
})

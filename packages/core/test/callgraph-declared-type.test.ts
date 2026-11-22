import { importEdge, starReexportEdge, symbolId } from "@aburi/test-support"
import type { ImportEdge, Symbol as IRSymbol } from "@aburi/types"
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
      "a class that does not declare the member itself, though another class does",
      [
        makeSymbol("ts:src/repo.ts#UserRepository", { kind: "class" }),
        makeSymbol("ts:src/other.ts#Index.find", { kind: "method" }),
      ],
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
      [...classes(USER, MIDDLE), method("ts:src/other.ts#Index.find")],
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
  const ROOT = "ts:src/base.ts#Root"
  const CONSTRUCTOR = `${ADMIN}.constructor`
  const SAVE = `${ADMIN}.save`
  const classes = (...ids: string[]) => ids.map((id) => makeSymbol(id, { kind: "class" }))
  const method = (id: string, overrides: SymbolOverrides = {}) =>
    makeSymbol(id, { kind: "method", ...overrides })
  const dropped = { dropped: true, dropReason: "cat-b:trivial" } as const

  interface SuperCall {
    target?: string
    type?: string
    hint?: string
  }

  // `AdminService extends BaseService`, which its file imports; the plugin types `super` with it.
  function resolveSuper(
    symbols: readonly IRSymbol[],
    heritages: readonly Heritage[] = [[ADMIN, "BaseService"]],
    { target = "super.save", type = "BaseService", hint }: SuperCall = {},
  ) {
    const caller = target === "super" ? CONSTRUCTOR : SAVE
    return resolveCallGraph({
      symbols: [withCalls(caller, [{ target, line: 3 }]), ...symbols],
      importsByFile: importsOf("src/admin.ts", { source: "./base", symbols: ["BaseService"] }),
      declaredReceiverTypes: new Map([[makeSymbolCallKey(caller, 3, target), type]]),
      classHeritages: heritagesOf(heritages),
      receiverHints: new Map(
        hint === undefined
          ? []
          : [
              [
                makeCallSiteKey("src/admin.ts", 3, target),
                { kind: "super", targetSymbolId: symbolId(hint) },
              ],
            ],
      ),
    })
  }

  it("resolves `super(…)` to the class, at high confidence", () => {
    const result = resolveSuper(classes(ADMIN, BASE), undefined, { target: "super" })
    expect(edgesOf(result)).toEqual([[CONSTRUCTOR, BASE, "high"]])
    expect(result.diagnostics).toEqual([])
  })

  it.each<[string, readonly IRSymbol[], readonly Heritage[], string, string]>([
    [
      "the class extends",
      [...classes(ADMIN, BASE), method(`${BASE}.save`)],
      [[ADMIN, "BaseService"]],
      "BaseService",
      `${BASE}.save`,
    ],
    [
      "a class two levels up",
      [...classes(ADMIN, MIDDLE, BASE), method(`${BASE}.save`)],
      [
        [ADMIN, "Middle"],
        [MIDDLE, "BaseService"],
      ],
      "Middle",
      `${BASE}.save`,
    ],
    [
      "the nearest of the classes up the chain that declare it",
      [...classes(ADMIN, MIDDLE, BASE), method(`${MIDDLE}.save`), method(`${BASE}.save`)],
      [
        [ADMIN, "Middle"],
        [MIDDLE, "BaseService"],
      ],
      "Middle",
      `${MIDDLE}.save`,
    ],
    [
      "a class it extends that a drop rule removed",
      [makeSymbol(BASE, { kind: "class", ...dropped }), method(`${BASE}.save`)],
      [[ADMIN, "BaseService"]],
      "BaseService",
      `${BASE}.save`,
    ],
    [
      "a class two levels up, through one a drop rule removed",
      [makeSymbol(MIDDLE, { kind: "class", ...dropped }), ...classes(BASE), method(`${BASE}.save`)],
      [[MIDDLE, "BaseService"]],
      "Middle",
      `${BASE}.save`,
    ],
  ])(
    "resolves `super.<member>` to the member %s, at high confidence",
    (_c, symbols, heritages, type, to) => {
      const result = resolveSuper(symbols, heritages, { type })
      expect(edgesOf(result)).toEqual([[SAVE, to, "high"]])
      expect(result.diagnostics).toEqual([])
    },
  )

  it("keeps the member it reaches over a hint for the call, which it does not read", () => {
    const result = resolveSuper(
      [...classes(BASE, ROOT), method(`${BASE}.save`), method(`${ROOT}.save`)],
      undefined,
      {
        hint: `${ROOT}.save`,
      },
    )
    expect(edgesOf(result)).toEqual([[SAVE, `${BASE}.save`, "high"]])
    expect(result.lspHintUsage).toEqual({ consumed: 0, kindMismatch: 0, targetDropped: 0 })
  })

  // `BaseService extends Root`, whose kept `save` a walk that went on past `BaseService` would reach.
  const aboveBase: readonly Heritage[] = [[BASE, "Root"]]
  const withRoot = (...symbols: IRSymbol[]) => [
    ...classes(BASE, ROOT),
    method(`${ROOT}.save`),
    ...symbols,
  ]

  it.each<[string, readonly IRSymbol[], readonly Heritage[], SuperCall]>([
    [
      "`super(…)` of a class a drop rule removed",
      [makeSymbol(BASE, { kind: "class", ...dropped })],
      [],
      { target: "super" },
    ],
    [
      "a member the class declares, though a drop rule removed it",
      withRoot(method(`${BASE}.save`, dropped)),
      aboveBase,
      {},
    ],
    [
      "a member the class holds in a field, which is no member of its prototype",
      withRoot(method(`${BASE}.save`, { derivedBy: ["class-method", "field-assigned-function"] })),
      aboveBase,
      {},
    ],
    [
      "a member the class holds in a field, a call handed its function",
      withRoot(method(`${BASE}.save`, { derivedBy: ["class-method", "call-argument-function"] })),
      aboveBase,
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
      [...classes(BASE), method(`${BASE}.repo`), method(`${BASE}.save`)],
      [],
      { target: "super.repo.save" },
    ],
  ])("leaves %s unresolved and `dynamic`", (_case, symbols, heritages, call) => {
    const result = resolveSuper(symbols, heritages, call)
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })
})

describe("a call through a variable another module declares, whose type that module names", () => {
  const CALLER_ID = "ts:src/use.ts#main"
  const VARIABLE = "ts:src/manager.ts#manager"
  const CLASS = "ts:src/classes.ts#Manager"
  const STOP = `${CLASS}.stop`
  const FROM_MANAGER: ImportClause = { source: "./manager", symbols: ["manager"] }
  const FROM_CLASSES: ImportClause = { source: "./classes", symbols: ["Manager"] }
  const manager = (file = "src/classes.ts") => [
    makeSymbol(`ts:${file}#Manager`, { kind: "class" }),
    makeSymbol(`ts:${file}#Manager.stop`, { kind: "method" }),
  ]

  interface Setup {
    target?: string
    variable?: SymbolOverrides
    importsByFile?: ReadonlyMap<string, readonly ImportEdge[]>
    imports?: ImportClause[]
    /** What the variable's own file imports. */
    variableImports?: ImportClause[]
    valueTypes?: ReadonlyMap<string, string>
    heritages?: readonly Heritage[]
    /** Whether the language plugin found the import binding the receiver's leading name. */
    marked?: boolean
  }

  // `src/manager.ts` declares `manager` with the type `Manager`, which it imports from `./classes`.
  function resolveImported(symbols: readonly IRSymbol[], setup: Setup = {}) {
    const { target = "manager.stop", imports = [FROM_MANAGER], marked = true } = setup
    return resolveCallGraph({
      symbols: [
        withCalls(CALLER_ID, [{ target, line: 3 }]),
        makeSymbol(VARIABLE, { kind: "const", ...setup.variable }),
        ...symbols,
      ],
      importsByFile:
        setup.importsByFile ??
        new Map([
          ...importsOf("src/use.ts", ...imports),
          ...importsOf("src/manager.ts", ...(setup.variableImports ?? [FROM_CLASSES])),
        ]),
      valueTypes: new Map(
        [...(setup.valueTypes ?? new Map([[VARIABLE, "Manager"]]))].map(([id, type]) => [
          symbolId(id),
          type,
        ]),
      ),
      importedReceivers: new Set(marked ? [makeSymbolCallKey(CALLER_ID, 3, target)] : []),
      classHeritages: heritagesOf(setup.heritages ?? []),
      moduleFiles: new Map([["ts", new Set(["src/lib.ts"])]]),
    })
  }

  it.each<[string, readonly IRSymbol[], Setup, string]>([
    ["a named import", manager(), {}, STOP],
    [
      "an import under another name",
      manager(),
      {
        imports: [{ source: "./manager", symbols: ["manager as current"] }],
        target: "current.stop",
      },
      STOP,
    ],
    [
      "a namespace import",
      manager(),
      {
        imports: [{ source: "./manager", symbols: "*", namespaceBinding: "managers" }],
        target: "managers.manager.stop",
      },
      STOP,
    ],
    [
      "a barrel that re-exports it, which does not bind the type itself",
      manager(),
      {
        importsByFile: new Map([
          ...importsOf("src/use.ts", { source: "./lib", symbols: ["manager"] }),
          ["src/lib.ts", [starReexportEdge("./manager")]],
          ...importsOf("src/manager.ts", FROM_CLASSES),
        ]),
      },
      STOP,
    ],
    [
      "a variable a drop rule removed",
      manager(),
      { variable: { dropped: true, dropReason: "cat-b:trivial" } },
      STOP,
    ],
    [
      "a class the variable's own file declares",
      manager("src/manager.ts"),
      { variableImports: [] },
      "ts:src/manager.ts#Manager.stop",
    ],
    [
      "a class the type extends",
      [
        ...manager(),
        makeSymbol("ts:src/classes.ts#Base", { kind: "class" }),
        makeSymbol("ts:src/classes.ts#Base.start", { kind: "method" }),
      ],
      { target: "manager.start", heritages: [[CLASS, "Base"]] },
      "ts:src/classes.ts#Base.start",
    ],
  ])(
    "resolves to the member of the type, through %s, at medium confidence",
    (_c, symbols, setup, to) => {
      const result = resolveImported(symbols, setup)
      expect(edgesOf(result)).toEqual([[CALLER_ID, to, "medium"]])
      expect(result.diagnostics).toEqual([])
    },
  )

  it.each<[string, readonly IRSymbol[], Setup]>([
    ["a variable its module names no type for", manager(), { valueTypes: new Map() }],
    [
      "a type its module binds to no class",
      [makeSymbol(CLASS, { kind: "interface" }), makeSymbol(STOP, { kind: "method" })],
      {},
    ],
    [
      "a type only the caller's file binds",
      manager(),
      { variableImports: [], imports: [FROM_MANAGER, FROM_CLASSES] },
    ],
    [
      "a member neither the type nor a class it extends declares, though another class does",
      [...manager(), makeSymbol("ts:src/engine.ts#Engine.start", { kind: "method" })],
      { target: "manager.start" },
    ],
    [
      "a call the language plugin finds no import under, as where a local of the name hides it",
      manager(),
      { marked: false },
    ],
    [
      "a variable of the caller's own file, which only an import's variable is read for",
      [...manager("src/use.ts"), makeSymbol("ts:src/use.ts#manager", { kind: "const" })],
      { imports: [], valueTypes: new Map([["ts:src/use.ts#manager", "Manager"]]) },
    ],
  ])("leaves %s unresolved, `no-match`", (_case, symbols, setup) => {
    const result = resolveImported(symbols, setup)
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
  })
})

import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanTypeScript } from "./fixtures/scan"

const workspace = useScratchWorkspace("call-resolution")

/** Write `modules` and a `main` in `file` that imports and calls into them, and scan. */
async function callsFromMain(
  modules: Record<string, string>,
  imports: readonly string[],
  calls: readonly string[],
  file = "src/use.ts",
) {
  for (const [path, source] of Object.entries(modules)) await workspace.writeSource(path, source)
  const body = calls.map((call) => `  ${call}`)
  const use = [...imports, "", "export function main() {", ...body, "}", ""].join("\n")
  await workspace.writeSource(file, use)

  const { ir, unresolvedCalls } = await scanTypeScript(workspace.root)
  const mainId = `ts:${file}#main`
  const main = ir.symbols.find((s) => s.id === mainId)
  return {
    resolved: main?.calls.map((c) => [c.target, c.resolved]),
    unresolved: unresolvedCalls
      .filter((d) => d.symbolId === mainId)
      .map((d) => [d.target, d.bucket]),
  }
}

describe("scan — calls through a default import", () => {
  it("reaches an anonymous default export, in either spelling of the import", async () => {
    const result = await callsFromMain(
      { "src/anon.ts": "export default (x: number) => x + 1\n" },
      ['import inc from "./anon"', 'import { default as add } from "./anon"'],
      ["inc(1)", "add(2)"],
    )
    expect(result).toEqual({
      resolved: [
        ["inc", "ts:src/anon.ts#<default>"],
        ["add", "ts:src/anon.ts#<default>"],
      ],
      unresolved: [],
    })
  })

  it("reaches an anonymous default export written behind a wrapper", async () => {
    const result = await callsFromMain(
      {
        "src/paren.ts": "export default (() => 1)\n",
        "src/satisfies.ts": "export default (async () => 2) satisfies () => Promise<number>\n",
      },
      ['import one from "./paren"', 'import two from "./satisfies"'],
      ["one()", "two()"],
    )
    expect(result).toEqual({
      resolved: [
        ["one", "ts:src/paren.ts#<default>"],
        ["two", "ts:src/satisfies.ts#<default>"],
      ],
      unresolved: [],
    })
  })

  it("reaches a named default export under another name, declared with, apart from or by a clause", async () => {
    const result = await callsFromMain(
      {
        "src/named.ts": "export default function makeApp() { return 3 }\n",
        "src/promoted.ts": "const f = () => 4\nexport default f\n",
        "src/clause.ts": "function connect() { return 1 }\nexport { connect as default }\n",
      },
      [
        'import createApp from "./named"',
        'import g from "./promoted"',
        'import open from "./clause"',
      ],
      ["createApp()", "g()", "open()"],
    )
    expect(result).toEqual({
      resolved: [
        ["createApp", "ts:src/named.ts#makeApp"],
        ["g", "ts:src/promoted.ts#f"],
        ["open", "ts:src/clause.ts#connect"],
      ],
      unresolved: [],
    })
  })

  it("reaches a default export written as a call, handed a function or not", async () => {
    const result = await callsFromMain(
      {
        "src/handler.ts": "export default withAuth(async (req: unknown) => {\n  save(req)\n})\n",
        "src/wrapped.ts":
          "function Page() { return 2 }\nfunction withAuth<T>(c: T): T { return c }\nexport default withAuth(Page)\n",
      },
      ['import handler from "./handler"', 'import Page from "./wrapped"'],
      ["handler({})", "Page()"],
    )
    expect(result).toEqual({
      resolved: [
        ["handler", "ts:src/handler.ts#<default>"],
        ["Page", "ts:src/wrapped.ts#<default>"],
      ],
      unresolved: [],
    })
  })

  it("reaches a static member through a default-imported class", async () => {
    const result = await callsFromMain(
      { "src/svc.ts": "export default class Svc {\n  static run() { return 5 }\n}\n" },
      ['import S from "./svc"'],
      ["S.run()"],
    )
    expect(result).toEqual({ resolved: [["S.run", "ts:src/svc.ts#Svc::run"]], unresolved: [] })
  })

  it("never takes the named export that shares the local name", async () => {
    const result = await callsFromMain(
      {
        "src/client.ts":
          "export default function createClient() { return 1 }\nexport function connect() { return 2 }\n",
        "src/plain.ts": "export function open() { return 3 }\n",
      },
      ['import connect from "./client"', 'import open from "./plain"'],
      ["connect()", "open()"],
    )
    expect(result).toEqual({
      resolved: [
        ["connect", "ts:src/client.ts#createClient"],
        ["open", null],
      ],
      unresolved: [["open", "no-match"]],
    })
  })

  it("resolves both bindings of `import Foo, * as Bar`", async () => {
    const result = await callsFromMain(
      {
        "src/mixed.ts":
          "export default function make() { return 1 }\nexport function helper() { return 2 }\n",
      },
      ['import build, * as m from "./mixed"'],
      ["build()", "m.helper()"],
    )
    expect(result).toEqual({
      resolved: [
        ["build", "ts:src/mixed.ts#make"],
        ["m.helper", "ts:src/mixed.ts#helper"],
      ],
      unresolved: [],
    })
  })

  it("leaves a static member of an anonymous default class unresolved, over a namesake", async () => {
    const result = await callsFromMain(
      {
        "src/anon-class.ts": "export default class {\n  static run() { return 3 }\n}\n",
        "src/namesake.ts": "export class Anon {\n  run() { return 5 }\n}\n",
      },
      ['import Anon from "./anon-class"'],
      ["Anon.run()"],
    )
    expect(result).toEqual({
      resolved: [["Anon.run", null]],
      unresolved: [["Anon.run", "no-match"]],
    })
  })

  it("reaches a default export a barrel re-exports, as its default or by name", async () => {
    const result = await callsFromMain(
      {
        "src/impl.ts": "export default function impl() { return 4 }\n",
        "src/barrel.ts": 'export { default } from "./impl"\n',
        "src/renamed-barrel.ts": 'export { default as impl } from "./impl"\n',
      },
      ['import viaBarrel from "./barrel"', 'import { impl } from "./renamed-barrel"'],
      ["viaBarrel()", "impl()"],
    )
    expect(result).toEqual({
      resolved: [
        ["viaBarrel", "ts:src/impl.ts#impl"],
        ["impl", "ts:src/impl.ts#impl"],
      ],
      unresolved: [],
    })
  })
})

describe("scan — a call through the name of a class a namespace merged into", () => {
  it("reaches the namespace's export, the member TypeScript calls", async () => {
    await workspace.writeSource(
      "src/c.ts",
      [
        "export class C {",
        "  m(n: number) {",
        "    return n",
        "  }",
        "}",
        "export namespace C {",
        "  export function m(n: number) {",
        "    return helper(n)",
        "  }",
        "}",
        "export function f() {",
        "  return C.m(1)",
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/g.ts",
      ["import { C } from './c'", "export function g() {", "  return C.m(2)", "}", ""].join("\n"),
    )

    const result = await scanTypeScript(workspace.root)
    const resolved = (id: string) =>
      result.ir.symbols.find((symbol) => symbol.id === id)?.calls.map((call) => call.resolved)

    expect(resolved("ts:src/c.ts#f")).toEqual(["ts:src/c.ts#C::m"])
    expect(resolved("ts:src/g.ts#g")).toEqual(["ts:src/c.ts#C::m"])
  })
})

describe("scan — a call through the name of a class that lacks the member", () => {
  const MODULES = {
    "src/audit-log.ts":
      "export class Logger {\n  log(message: string) {\n    return message\n  }\n}\n",
    "src/base-logger.ts": "export class Logger {}\n",
    "src/barrel.ts":
      'export { Logger } from "./audit-log"\nexport function other() {\n  return 1\n}\n',
  }

  it.each([
    ["a class the caller's file declares", "class Logger {}"],
    ["a class of fields the caller's file declares, dropped", "class Logger {\n  level = 1\n}"],
    ["a named import of a class its module declares", 'import { Logger } from "./base-logger"'],
  ])("stops at %s, bucketed `no-match`", async (_label, head) => {
    expect(await callsFromMain(MODULES, [head], ['Logger.log("x")'])).toEqual({
      resolved: [["Logger.log", null]],
      unresolved: [["Logger.log", "no-match"]],
    })
  })

  it.each([
    ["a barrel that re-exports it", "src/use.ts", 'import { Logger } from "./barrel"'],
    ["a workspace package", "src/use.ts", 'import { Logger } from "@acme/logging"'],
    ["a `require` in JavaScript", "src/use.js", 'const { Logger } = require("./audit-log")'],
    ["an ambient declaration", "src/use.ts", "declare const Logger: { log(m: string): string }"],
  ])("searches on past %s to the class that declares the member", async (_label, file, head) => {
    expect(await callsFromMain(MODULES, [head], ['Logger.log("x")'], file)).toEqual({
      resolved: [["Logger.log", "ts:src/audit-log.ts#Logger.log"]],
      unresolved: [],
    })
  })
})

describe("scan — a call through the name of a dropped class", () => {
  it("reaches a member a namespace merged into the class keeps", async () => {
    const head = [
      "class Config {",
      "  static readonly A = 1",
      "}",
      "namespace Config {",
      "  export function load() {",
      "    return 2",
      "  }",
      "}",
    ]
    expect(await callsFromMain({}, head, ["Config.load()"])).toEqual({
      resolved: [["Config.load", "ts:src/use.ts#Config::load"]],
      unresolved: [],
    })
  })
})

describe("scan — a call through a field of a declared type", () => {
  it("reaches the member of the class the field is declared with, and only of a class", async () => {
    await workspace.writeSource(
      "src/repo.ts",
      [
        "export class UserRepository {",
        "  find(id: string) { return id }",
        "}",
        "export interface Store { find(id: string): string }",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/service.ts",
      [
        'import { type Store, UserRepository } from "./repo"',
        "export class Base { protected inherited: UserRepository = new UserRepository() }",
        "export class UserService extends Base {",
        "  private untyped",
        "  private either: UserRepository | null = null",
        "  private both: UserRepository | Store",
        "  private readonly made = new UserRepository()",
        "  private reassignable = new UserRepository()",
        "  constructor(private readonly repo: UserRepository, private store: Store) {",
        "    super()",
        "    this.untyped = repo",
        "  }",
        "  byId(id: string) {",
        "    this.repo.find(id)",
        "    this.untyped.find(id)",
        "    this.either.find(id)",
        "    this.both.find(id)",
        "    this.inherited.find(id)",
        "    this.store.find(id)",
        "    this.made.find(id)",
        "    this.reassignable.find(id)",
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const { ir } = await scanTypeScript(workspace.root)
    const byId = ir.symbols.find((s) => s.id === "ts:src/service.ts#UserService.byId")
    expect(byId?.calls.map((call) => [call.target, call.resolved])).toEqual([
      ["this.repo.find", "ts:src/repo.ts#UserRepository.find"],
      ["this.untyped.find", null],
      ["this.either.find", "ts:src/repo.ts#UserRepository.find"],
      ["this.both.find", null],
      ["this.inherited.find", null],
      ["this.store.find", null],
      ["this.made.find", "ts:src/repo.ts#UserRepository.find"],
      ["this.reassignable.find", null],
    ])
  })

  /**
   * Write two repositories and an interface, and `service`, which imports them through
   * `specifier`, and scan: each calling Symbol's calls, and how the unresolved ones are bucketed.
   */
  async function scanService(service: readonly string[], specifier = "./repo") {
    await workspace.writeSource(
      "src/repo.ts",
      [
        "export class UserRepository { find(id: string) { return id } }",
        "export class AdminRepository { find(id: string) { return id } }",
        "export interface Finder { find(id: string): string }",
        "",
      ].join("\n"),
    )
    const imports = `import { AdminRepository, type Finder, UserRepository } from "${specifier}"`
    await workspace.writeSource("src/service.ts", [imports, ...service, ""].join("\n"))
    const { ir, unresolvedCalls } = await scanTypeScript(workspace.root)
    const nameOf = (id: string) => id.slice(id.indexOf("#") + 1)
    return {
      calls: Object.fromEntries(
        ir.symbols
          .filter((s) => s.source.file === "src/service.ts" && s.calls.length > 0)
          .map((s) => [nameOf(s.id), s.calls.map((call) => call.resolved)]),
      ),
      buckets: unresolvedCalls.map((d) => [nameOf(d.symbolId), d.target, d.bucket]),
    }
  }

  async function callsByMember(service: readonly string[], specifier = "./repo") {
    return (await scanService(service, specifier)).calls
  }

  const USER_FIND = "ts:src/repo.ts#UserRepository.find"
  const ADMIN_FIND = "ts:src/repo.ts#AdminRepository.find"

  it("resolves the calls one line holds alike, and none where their types differ", async () => {
    const calls = await callsByMember([
      "export class S {",
      "  constructor(private readonly repo: UserRepository) {}",
      '  twice() { return this.repo.find("a") ?? this.repo.find("b") }',
      '  nested() { return [this.repo.find("a"), class { repo!: AdminRepository; n() { this.repo.find("b") } }] }',
      '  untyped() { return [this.repo.find("a"), function (this: any) { this.repo.find("b") }] }',
      "}",
    ])
    expect(calls).toEqual({
      "S.twice": [USER_FIND, USER_FIND],
      "S.nested": [null, null],
      "S.untyped": [null, null],
    })
  })

  it("keeps apart two classes written on one line", async () => {
    const calls = await callsByMember([
      'export class A { constructor(private r: UserRepository) {} m() { this.r.find("a") } }; export class B { constructor(private r: AdminRepository) {} m() { this.r.find("b") } }',
    ])
    expect(calls).toEqual({ "A.m": [USER_FIND], "B.m": [ADMIN_FIND] })
  })

  it("leaves a type parameter to its class, though a class of its name is imported", async () => {
    const calls = await callsByMember([
      "export class Box<UserRepository> {",
      "  constructor(private readonly item: UserRepository) {}",
      '  put() { this.item.find("a") }',
      "}",
    ])
    expect(calls).toEqual({ "Box.put": [null] })
  })

  it("reaches the member of the class a name is declared or constructed with", async () => {
    const { calls, buckets } = await scanService([
      "const shared = new UserRepository()",
      'export function byParameter(repo: UserRepository) { repo.find("a") }',
      'export function byConst() { const repo = new AdminRepository(); repo.find("a") }',
      'export function byModule() { shared.find("a") }',
      'export function shadowed(repo: UserRepository) { { const repo = make(); repo.find("a") } }',
      'export function byInterface(repo: Finder) { repo.find("a") }',
    ])
    expect(calls).toEqual({
      byParameter: [USER_FIND],
      byConst: ["ts:src/repo.ts#AdminRepository", ADMIN_FIND],
      byModule: [USER_FIND],
      shadowed: [null, null],
      byInterface: [null],
    })
    // What the declared type leaves keeps the bucket the earlier steps gave it.
    expect(buckets).toEqual([
      ["byInterface", "repo.find", "local-scope"],
      ["shadowed", "make", "external"],
      ["shadowed", "repo.find", "local-scope"],
    ])
  })

  it("reaches a class imported through a tsconfig path alias", async () => {
    await workspace.writeSource(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { paths: { "@repo/*": ["src/*"] } } }),
    )
    const calls = await callsByMember(
      [
        "export class S {",
        "  constructor(private readonly repo: UserRepository) {}",
        '  m() { this.repo.find("a") }',
        "}",
      ],
      "@repo/repo",
    )
    expect(calls).toEqual({ "S.m": [USER_FIND] })
  })
})

describe("scan — a call of a member of `this`", () => {
  it("reaches the member the class declares or inherits, and leaves a rebound `this`", async () => {
    await workspace.writeSource(
      "src/service.ts",
      [
        "export class Base { load() { return 1 } }",
        "export class UserService extends Base {",
        "  byId(id: string) {",
        "    this.find(id)",
        "    this.helper(id)",
        "    this.load()",
        "    const later = () => this.find(id)",
        "    return [later, function () { this.find(id) }]",
        "  }",
        "  find(id: string) { return id }",
        "  helper = (id: string) => id",
        "}",
        "",
      ].join("\n"),
    )

    const { ir } = await scanTypeScript(workspace.root)
    const byId = ir.symbols.find((s) => s.id === "ts:src/service.ts#UserService.byId")
    expect(byId?.calls.map((call) => [call.target, call.resolved])).toEqual([
      ["this.find", "ts:src/service.ts#UserService.find"],
      ["this.helper", "ts:src/service.ts#UserService.helper"],
      ["this.load", "ts:src/service.ts#Base.load"],
      ["this.find", "ts:src/service.ts#UserService.find"],
      ["this.find", null],
    ])
  })
})

describe("scan — a call of a function or method declared with no body", () => {
  it("reaches an abstract member, through `this` and through a value of its class", async () => {
    await workspace.writeSource(
      "src/repo.ts",
      [
        "export abstract class Repo {",
        "  abstract find(id: string): string",
        "  load(id: string) { return this.find(id) }",
        "}",
        'export function use(repo: Repo) { return repo.find("1") }',
        "",
      ].join("\n"),
    )

    const { ir, unresolvedCalls } = await scanTypeScript(workspace.root)
    const callsOf = (id: string) =>
      ir.symbols.find((s) => s.id === id)?.calls.map((call) => [call.target, call.resolved])
    expect(callsOf("ts:src/repo.ts#Repo.load")).toEqual([["this.find", "ts:src/repo.ts#Repo.find"]])
    expect(callsOf("ts:src/repo.ts#use")).toEqual([["repo.find", "ts:src/repo.ts#Repo.find"]])
    expect(unresolvedCalls).toEqual([])
  })

  it("passes over one written under `declare`, to the implementation or to no Symbol", async () => {
    await workspace.writeSource(
      "src/a.ts",
      [
        "declare namespace Analytics { function track(e: string): void }",
        "declare class Logger { log(m: string): void }",
        'export function here(l: Logger) { Analytics.track("x"); l.log("m") }',
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/b.ts",
      "export const Analytics = { track(e: string) { return e } }\n",
    )
    await workspace.writeSource("src/c.ts", 'export function there() { Analytics.track("x") }\n')
    await workspace.writeSource("src/g.ts", "export declare function load(id: string): string\n")
    await workspace.writeSource(
      "src/use.ts",
      'import { load } from "./g"\nexport function loads() { return load("1") }\n',
    )

    const { ir, unresolvedCalls } = await scanTypeScript(workspace.root)
    const callsOf = (id: string) =>
      ir.symbols.find((s) => s.id === id)?.calls.map((call) => [call.target, call.resolved])
    expect(callsOf("ts:src/a.ts#here")).toEqual([
      ["Analytics.track", "ts:src/b.ts#Analytics.track"],
      ["l.log", null],
    ])
    expect(callsOf("ts:src/c.ts#there")).toEqual([
      ["Analytics.track", "ts:src/b.ts#Analytics.track"],
    ])
    expect(callsOf("ts:src/use.ts#loads")).toEqual([["load", null]])
    expect(unresolvedCalls.map((d) => [d.symbolId, d.target, d.bucket])).toEqual([
      ["ts:src/a.ts#here", "l.log", "local-scope"],
      ["ts:src/use.ts#loads", "load", "no-match"],
    ])
    expect(
      ["ts:src/a.ts#Analytics.track", "ts:src/a.ts#Logger.log", "ts:src/g.ts#load"].map(
        (id) => ir.symbols.find((s) => s.id === id)?.dropped,
      ),
    ).toEqual([false, false, false])
  })
})

describe("scan — a call of a member a class inherits", () => {
  it("reaches the nearest class up the chain that declares it, each bound where its class is", async () => {
    const result = await callsFromMain(
      {
        "src/base.ts": [
          "export class Repository {",
          "  find(id: string) { return id }",
          "  save(id: string) { return id }",
          "}",
          "",
        ].join("\n"),
        "src/admin.ts": [
          'import { Repository } from "./base"',
          "export class AdminRepository extends Repository {",
          "  save(id: string) { return id }",
          "}",
          "",
        ].join("\n"),
      },
      ['import { AdminRepository } from "./admin"'],
      ["const repo = new AdminRepository()", 'repo.find("a")', 'repo.save("a")'],
    )
    expect(result).toEqual({
      resolved: [
        ["AdminRepository", "ts:src/admin.ts#AdminRepository"],
        ["repo.find", "ts:src/base.ts#Repository.find"],
        ["repo.save", "ts:src/admin.ts#AdminRepository.save"],
      ],
      unresolved: [],
    })
  })

  const BASE = [
    "export class Repository {",
    "  find(id: string) { return id }",
    "}",
    "export default Repository",
    "",
  ].join("\n")
  const FIND = "ts:src/base.ts#Repository.find"

  /** Each Symbol of `src/kinds.ts` that calls, by qualified name, with where each call resolved. */
  async function callsOfKinds(kinds: readonly string[]) {
    await workspace.writeSource("src/base.ts", BASE)
    await workspace.writeSource("src/kinds.ts", [...kinds, ""].join("\n"))
    const { ir } = await scanTypeScript(workspace.root)
    return Object.fromEntries(
      ir.symbols
        .filter((s) => s.source.file === "src/kinds.ts" && s.calls.length > 0)
        .map((s) => [s.name, s.calls.map((call) => [call.target, call.resolved])]),
    )
  }

  it("reaches it through a default or a namespace import, a class a binding holds, a field, a class a drop rule removed, and a field that only narrows its type", async () => {
    const calls = await callsOfKinds([
      'import Base from "./base"',
      'import * as b from "./base"',
      "export class ByDefault extends Base {}",
      "export class ByNamespace extends b.Repository {}",
      "export const Held = class extends Base {}",
      "export class Dto extends Base { table = 'users' }",
      'export class Narrowed extends Base { find!: Base["find"] }',
      "export function main(d: ByDefault, n: ByNamespace, o: Dto, t: Narrowed) {",
      "  const h = new Held()",
      '  d.find("a")',
      '  n.find("a")',
      '  h.find("a")',
      '  o.find("a")',
      '  t.find("a")',
      "}",
      "export class Service {",
      "  constructor(private readonly repo: ByDefault) {}",
      '  m() { return this.repo.find("a") }',
      "}",
    ])
    expect(calls).toEqual({
      main: [
        ["Held", "ts:src/kinds.ts#Held"],
        ["d.find", FIND],
        ["n.find", FIND],
        ["h.find", FIND],
        ["o.find", FIND],
        ["t.find", FIND],
      ],
      "Service.m": [["this.repo.find", FIND]],
    })
  })

  it("reaches the class `super(…)` constructs and the member `super.<member>` reads", async () => {
    const calls = await callsOfKinds([
      'import { Repository } from "./base"',
      "export class Admin extends Repository {",
      "  constructor() { super() }",
      "  find(id: string) { return super.find(id) }",
      "}",
    ])
    const constructs = [["super", "ts:src/base.ts#Repository"]]
    expect(calls).toEqual({
      Admin: constructs,
      "Admin.constructor": constructs,
      "Admin.find": [["super.find", FIND]],
    })
  })

  it("leaves it where the class's own member hides it, a Symbol or not", async () => {
    const calls = await callsOfKinds([
      'import { Repository } from "./base"',
      "export class WithField extends Repository {",
      "  find = make()",
      "  m() { return this.find() }",
      "}",
      "export class WithProperty extends Repository {",
      "  constructor(public find: () => string) { super() }",
      "}",
      "export class WithAssigned extends Repository {",
      "  constructor() { super(); this.find = () => 'x' }",
      "}",
      "export class WithGetter extends Repository {",
      "  get find() { return () => 'y' }",
      "}",
      "export class WithInit extends Repository {",
      "  find!: () => string",
      "  init() { this.find = () => 'z' }",
      "}",
      "export function main(f: WithField, p: WithProperty, a: WithAssigned, g: WithGetter, i: WithInit) {",
      "  f.find()",
      "  p.find()",
      "  a.find()",
      "  g.find()",
      "  i.find()",
      "}",
    ])
    expect({ "WithField.m": calls["WithField.m"], main: calls.main }).toEqual({
      "WithField.m": [["this.find", null]],
      main: [
        ["f.find", null],
        ["p.find", null],
        ["a.find", null],
        ["g.find", "ts:src/kinds.ts#WithGetter.find"],
        ["i.find", null],
      ],
    })
  })
})

describe("scan — a call through a variable another module declares", () => {
  it("reaches the member of the class its module declares it with, the type bound there, unless a local hides the import", async () => {
    const result = await callsFromMain(
      {
        "src/manager.ts": [
          'import { Manager } from "./classes"',
          "export const manager = new Manager()",
          "export let current: Manager | null = null",
          "export const made = make()",
          "",
        ].join("\n"),
        "src/classes.ts": [
          "export class Base {",
          "  start(id: string) { return id }",
          "}",
          "export class Manager extends Base {",
          "  stop(id: string) { return id }",
          "}",
          "",
        ].join("\n"),
      },
      [
        'import { current, made, manager } from "./manager"',
        'import * as managers from "./manager"',
      ],
      [
        'manager.stop("a")',
        'manager.start("a")',
        'current.stop("a")',
        'managers.manager.stop("a")',
        'made.stop("a")',
        '{ let manager; manager.stop("b") }',
        'for (const manager of []) manager.stop("c")',
      ],
    )
    const STOP = "ts:src/classes.ts#Manager.stop"
    expect(result).toEqual({
      resolved: [
        ["manager.stop", STOP],
        ["manager.start", "ts:src/classes.ts#Base.start"],
        ["current.stop", STOP],
        ["managers.manager.stop", STOP],
        ["made.stop", null],
        ["manager.stop", null],
        ["manager.stop", null],
      ],
      unresolved: [
        ["made.stop", "no-match"],
        ["manager.stop", "no-match"],
        ["manager.stop", "no-match"],
      ],
    })
  })
})

describe("scan — a call through a name an export clause gives", () => {
  it("reaches the declaration the clause exports under that name", async () => {
    const result = await callsFromMain(
      {
        "src/lib.ts": [
          "function stringType() { return 1 }",
          "class Impl { static make() { return 2 } }",
          "export { stringType as string, Impl as Service }",
          "",
        ].join("\n"),
      },
      ['import { Service, string } from "./lib"', 'import * as lib from "./lib"'],
      ["string()", "Service.make()", "lib.string()"],
    )
    expect(result).toEqual({
      resolved: [
        ["string", "ts:src/lib.ts#stringType"],
        ["Service.make", "ts:src/lib.ts#Impl::make"],
        ["lib.string", "ts:src/lib.ts#stringType"],
      ],
      unresolved: [],
    })
  })
})

describe("scan — a call through a tsconfig path alias", () => {
  it("reaches the Symbol the alias names, and buckets what it cannot reach by where it led", async () => {
    const result = await callsFromMain(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            paths: { "@app/billing": ["libs/billing/src/index.ts"], "@lib/*": ["libs/*/src"] },
          },
        }),
        "libs/billing/src/index.ts": "export function formatInvoice() { return 1 }\n",
        "libs/tax/src/index.ts": "export class Tax { static rate() { return 2 } }\n",
      },
      [
        'import { formatInvoice, missing as gone } from "@app/billing"',
        'import * as tax from "@lib/tax"',
        'import { sortBy } from "lodash"',
      ],
      ["formatInvoice()", "tax.Tax.rate()", "gone()", "sortBy()"],
    )
    expect(result).toEqual({
      resolved: [
        ["formatInvoice", "ts:libs/billing/src/index.ts#formatInvoice"],
        ["tax.Tax.rate", "ts:libs/tax/src/index.ts#Tax::rate"],
        ["gone", null],
        ["sortBy", null],
      ],
      unresolved: [
        ["gone", "no-match"],
        ["sortBy", "external"],
      ],
    })
  })
})

describe("scan — a call through a barrel", () => {
  it("reaches the declaration the barrel's re-exports lead to, and buckets a package's `external`", async () => {
    const result = await callsFromMain(
      {
        "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["libs/*"] } } }),
        "src/lib/index.ts": [
          'export * from "./format"',
          'export { total as sum } from "./math"',
          'export { Tax } from "@lib/tax"',
          'export { sortBy } from "lodash"',
          'export type * from "./types"',
          "",
        ].join("\n"),
        "src/lib/format.ts": "export function format() { return 1 }\n",
        "src/lib/math.ts": "export function total() { return 2 }\n",
        "src/lib/types.ts": "export function typed() { return 3 }\n",
        "libs/tax.ts": "export class Tax { static rate() { return 4 } }\n",
      },
      ['import { format, sum, Tax, sortBy, typed } from "./lib"'],
      ["format()", "sum()", "Tax.rate()", "sortBy()", "typed()"],
    )
    expect(result).toEqual({
      resolved: [
        ["format", "ts:src/lib/format.ts#format"],
        ["sum", "ts:src/lib/math.ts#total"],
        ["Tax.rate", "ts:libs/tax.ts#Tax::rate"],
        ["sortBy", null],
        ["typed", null],
      ],
      unresolved: [
        ["sortBy", "external"],
        ["typed", "no-match"],
      ],
    })
  })
})

describe("scan — a call into a workspace package by its name", () => {
  it("reaches the file the package's manifest names, past its built ones, and none for a name two manifests share", async () => {
    const sources: Record<string, string> = {
      "packages/kit/src/index.ts": 'export * from "./sort"\n',
      "packages/kit/src/sort.ts": "export function sortBy() { return 1 }\n",
      "packages/legacy/index.ts": "export function legacy() { return 2 }\n",
      "packages/twin-a/index.ts": "export function twin() { return 3 }\n",
      "packages/twin-b/index.ts": "export function twin() { return 4 }\n",
      "apps/web/use.ts": [
        'import { sortBy, missing } from "@acme/kit"',
        'import { legacy } from "@acme/legacy"',
        'import { other } from "@acme/kit-extra"',
        'import { twin } from "@acme/twin"',
        "export function main() {",
        "  sortBy()",
        "  legacy()",
        "  missing()",
        "  other()",
        "  twin()",
        "}",
        "",
      ].join("\n"),
    }
    for (const [path, source] of Object.entries(sources)) await workspace.writeSource(path, source)
    const { ir, unresolvedCalls } = await scanTypeScript(
      workspace.root,
      {},
      {
        workspacePackages: [
          {
            name: "@acme/kit",
            root: "packages/kit",
            entry: { exports: { ".": { import: "./dist/index.js", source: "./src/index.ts" } } },
          },
          { name: "@acme/legacy", root: "packages/legacy", entry: { main: "./index.js" } },
          { name: "@acme/twin", root: "packages/twin-a" },
          { name: "@acme/twin", root: "packages/twin-b" },
        ],
      },
    )
    const main = ir.symbols.find((symbol) => symbol.id === "ts:apps/web/use.ts#main")
    expect(main?.calls.map((call) => [call.target, call.resolved])).toEqual([
      ["sortBy", "ts:packages/kit/src/sort.ts#sortBy"],
      ["legacy", "ts:packages/legacy/index.ts#legacy"],
      ["missing", null],
      ["other", null],
      ["twin", null],
    ])
    expect(unresolvedCalls.map((d) => [d.target, d.bucket])).toEqual([
      ["missing", "no-match"],
      ["other", "external"],
      ["twin", "external"],
    ])
  })
})

describe("scan — a call through what another call gave back", () => {
  it("reaches the member of the class the callee gives back, each callee read where it is declared", async () => {
    const result = await callsFromMain(
      {
        "src/box.ts": [
          "export class Box {",
          "  #n = 0",
          "  run(id: string) { return id + this.#n }",
          "  with(n: number): this {",
          "    this.#n = n",
          "    return this",
          "  }",
          "  static create() { return new Box() }",
          "}",
          "",
        ].join("\n"),
        "src/make.ts": [
          'import { Box } from "./box"',
          "export function make() { return new Box() }",
          "export function build() { return make() }",
          "export const create = make",
          "export async function load() { return new Box() }",
          "",
        ].join("\n"),
      },
      ['import { Box } from "./box"', 'import { build, create, load, make } from "./make"'],
      [
        'make().run("a")',
        'build().run("a")',
        'create().run("a")',
        'make().with(1).run("a")',
        'Box.create().run("a")',
        "const made = make()",
        'made.run("a")',
        'load().run("a")',
        '{ let held = make(); held.run("a") }',
      ],
    )
    const RUN = "ts:src/box.ts#Box.run"
    expect(result.resolved?.filter(([target]) => target?.endsWith(".run"))).toEqual([
      ["make.run", RUN],
      ["build.run", RUN],
      ["create.run", RUN],
      ["make.with.run", RUN],
      ["Box.create.run", RUN],
      ["made.run", RUN],
      ["load.run", null],
      ["held.run", null],
    ])
  })
})

describe("scan — a call through a method that gives back `this`", () => {
  it("reaches the member of the receiver's own class, an override included", async () => {
    const result = await callsFromMain(
      {
        "src/base.ts": [
          "export class Base {",
          "  with(n: number): this { return this }",
          "  chain(n: number) { return this }",
          "  save() { return 1 }",
          "}",
          "export class Sub extends Base {",
          "  save() { return 2 }",
          "  only() { return 3 }",
          "}",
          "export function makeSub() { return new Sub() }",
          "export const sub: Sub = new Sub()",
          "",
        ].join("\n"),
      },
      ['import { Base, makeSub, Sub, sub } from "./base"'],
      [
        "sub.chain(1).save()",
        "new Sub().with(1).save()",
        "makeSub().with(1).save()",
        "makeSub().with(1).only()",
        "new Base().with(1).chain(2).save()",
      ],
    )
    const SUB_SAVE = "ts:src/base.ts#Sub.save"
    expect(result.resolved?.filter(([target]) => /\.(save|only)$/.test(target ?? ""))).toEqual([
      ["sub.chain.save", SUB_SAVE],
      ["<computed>.with.save", SUB_SAVE],
      ["makeSub.with.save", SUB_SAVE],
      ["makeSub.with.only", "ts:src/base.ts#Sub.only"],
      ["<computed>.with.chain.save", "ts:src/base.ts#Base.save"],
    ])
  })

  it("reaches the override from a member of the subclass that calls through `this`", async () => {
    await workspace.writeSource(
      "src/base.ts",
      [
        "export class Base {",
        "  with(n: number): this { return this }",
        "  save() { return 1 }",
        "}",
        "export class Sub extends Base {",
        "  save() { return 2 }",
        "  again() { return this.with(1).save() }",
        "}",
        "",
      ].join("\n"),
    )
    const { ir } = await scanTypeScript(workspace.root)
    const again = ir.symbols.find((s) => s.id === "ts:src/base.ts#Sub.again")
    expect(again?.calls.map((c) => [c.target, c.resolved])).toEqual([
      ["this.with.save", "ts:src/base.ts#Sub.save"],
      ["this.with", "ts:src/base.ts#Base.with"],
    ])
  })
})

describe("scan — a call no declaration the scan read can be the callee of", () => {
  it("buckets a global's call and a member nothing in the workspace names `external`", async () => {
    const result = await callsFromMain(
      {
        "src/store.ts": [
          'import { EventEmitter } from "node:events"',
          "export class Store extends EventEmitter {",
          '  save() { this.emit("saved") }',
          "}",
          "",
        ].join("\n"),
      },
      ['import { Store } from "./store"'],
      [
        "setTimeout(() => {}, 1)",
        "expect(1).toBe(1)",
        "const items = [1, 2]",
        "items.map(String)",
        "items.save()",
        "const store = new Store()",
        "store.flush()",
        "localHelper()",
      ],
    )
    expect(result.unresolved).toEqual([
      ["setTimeout", "external"],
      ["expect", "external"],
      ["expect.toBe", "external"],
      ["items.map", "external"],
      ["items.save", "no-match"],
      ["store.flush", "external"],
      ["localHelper", "external"],
    ])
  })
})

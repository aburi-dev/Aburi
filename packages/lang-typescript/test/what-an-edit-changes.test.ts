import { delta, symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { changedSymbols, diffOfEdit, editOf } from "./fixtures/scan"

const workspace = useScratchWorkspace("edit-axis")

const FILE = "src/a.ts"

/** `f` with this parameter list and a body that stays the same, so only the list differs. */
const withParams = (params: string) => `export function f(${params}): void {\n  use()\n}\n`

const perm = (role: string) =>
  [
    "interface User { role: string }",
    "",
    `export const canEdit = (u: User) => u.role === "${role}"`,
    "",
    "export function canEditBlock(u: User) {",
    `  return u.role === "${role}"`,
    "}",
    "",
  ].join("\n")

const ledger = (credit: string, gate: string) =>
  [
    "export function applyCredit(balance: number, amount: number): number {",
    `  const next = balance ${credit} amount`,
    "  save(next)",
    "  return next",
    "}",
    "",
    "export function canDelete(isOwner: boolean, isAdmin: boolean): void {",
    `  audit(isOwner ${gate} isAdmin)`,
    "}",
    "",
  ].join("\n")

const sumAll = (bound: string) =>
  [
    "export function sumAll(xs: number[]): number {",
    "  let total = 0",
    `  for (let i = 0; i ${bound} xs.length; i++) {`,
    "    total += xs[i]",
    "  }",
    "  return total",
    "}",
    "",
  ].join("\n")

const route = (label: string) =>
  [
    "export function route(role: string): void {",
    "  switch (role) {",
    `    case ${label}:`,
    "      purgeAll()",
    "      break",
    "    default:",
    "      backup()",
    "  }",
    "}",
    "",
  ].join("\n")

const colors = (...members: string[]) => `export enum Color {\n  ${members.join(",\n  ")},\n}\n`

const parser = (overload: string) =>
  [
    "export interface Config { name: string }",
    "",
    "export function parse(input: string): Config;",
    `export function parse(input: ${overload}): Config;`,
    "export function parse(input: any): any {",
    "  return decode(input)",
    "}",
    "",
  ].join("\n")

const repository = (...overloads: string[]) =>
  [
    "export class Repository {",
    ...overloads.map((overload) => `  find(id: ${overload}): User;`),
    "  find(id: any): any {",
    "    return load(id)",
    "  }",
    "}",
    "",
  ].join("\n")

const registry = (...fields: string[]) =>
  [
    "export class Registry {",
    ...fields.map((field) => `  ${field}`),
    "  static {",
    "    load()",
    "  }",
    "}",
    "",
  ].join("\n")

const price = (guardNote: string, returnNote: string) =>
  [
    "export function price(qty: number, unit: number, member: boolean): number {",
    `  if (qty <= 0 ${guardNote}|| unit < 0) {`,
    '    throw new RangeError("bad input")',
    "  }",
    `  return member ? qty * unit * 0.9 ${returnNote}: qty * unit`,
    "}",
    "",
  ].join("\n")

const check = (...condition: string[]) =>
  [
    "export function check(user: { age: number; banned: boolean; role: string }) {",
    `  if (${condition.join("\n")}) {`,
    '    throw new Error("denied")',
    "  }",
    "  return user.role",
    "}",
    "",
  ].join("\n")

const accessor = (parameter: string) =>
  `export class C {\n  get x() {\n    return 1\n  }\n  set x(${parameter}: number) {\n    use()\n  }\n}\n`

const firstNegativeRow = (onZero: string, onNegative: string) =>
  [
    "export function firstNegativeRow(grid: number[][]) {",
    "  outer: for (const row of grid) {",
    "    inner: for (const v of row) {",
    `      if (v === 0) continue ${onZero}`,
    `      if (v < 0) break ${onNegative}`,
    "      mark(v)",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n")

const get = (thrown: string) =>
  `export function get(id: string) {\n  if (!id) throw ${thrown}\n  return lookup(id)\n}\n`

const CONNECT = "function connect() {\n  return open()\n}\n"
const PAGE = "function Page() {\n  return render()\n}\n"

const SYNTAX_ONLY = delta({ syntaxChanged: true })

describe("an edit to what a caller passes or gets is an api change", () => {
  it.each([
    [
      "a parenthesis-free arrow losing its parameter",
      'export const f = name => "hi"\n',
      'export const f = () => "hi"\n',
      true,
    ],
    [
      "an optional parameter made required",
      withParams("query?: string"),
      withParams("query: string"),
      true,
    ],
    [
      "an array parameter made a rest parameter",
      withParams("tags: string[]"),
      withParams("...tags: string[]"),
      true,
    ],
    ["a parameter retyped", withParams("limit: number"), withParams("limit: string"), true],
    ["a default dropped", withParams("limit: number = 10"), withParams("limit: number"), true],
    [
      "a return type, outside the parameter list",
      "export function f(): void {\n  use()\n}\n",
      "export function f(): string {\n  use()\n}\n",
      false,
    ],
    [
      "a type parameter, outside the parameter list",
      "export function f(): void {\n  use()\n}\n",
      "export function f<T>(): void {\n  use()\n}\n",
      false,
    ],
  ])(
    "reports %s, and on the syntax axis only an edit to the list",
    async (_label, before, after, syntaxChanged) => {
      const diff = await diffOfEdit(workspace, FILE, before, after)

      expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
      expect(changedSymbols(diff)).toMatchObject([
        { name: "f", apiChanged: true, logicChanged: false, syntaxChanged },
      ])
    },
  )
})

describe("an edit to what a function throws is an api and a logic change", () => {
  it("reads the thrown class past a comment after `throw`", async () => {
    const diff = await diffOfEdit(
      workspace,
      FILE,
      get('/* legacy path */ new NotFound("id")'),
      get('/* legacy path */ new Gone("id")'),
    )

    expect(changedSymbols(diff)).toMatchObject([
      { name: "get", apiChanged: true, logicChanged: true },
    ])
  })
})

describe("an edit to a declaration that has no body is an api change", () => {
  it.each([
    [
      "an abstract method's signature",
      "export abstract class Repo {\n  abstract find(id: string): Promise<User>\n}\n",
      "export abstract class Repo {\n  abstract find(id: number, opts?: Opts): Promise<User | null>\n}\n",
      "Repo.find",
      "Repo",
    ],
    [
      "a declared function's signature",
      "export declare function load(id: string): Promise<User>\n",
      "export declare function load(id: number): Promise<User | null>\n",
      "load",
      null,
    ],
    [
      "a declared class's method signature",
      "export declare class Client {\n  get(id: string): User\n}\n",
      "export declare class Client {\n  get(id: string, fresh: boolean): User\n}\n",
      "Client.get",
      "Client",
    ],
  ])(
    "reports %s on the Symbol it declares, kept on both sides",
    async (_label, before, after, name, owner) => {
      const diff = await diffOfEdit(workspace, FILE, before, after)
      const owners = owner === null ? [] : [{ name: owner, ...SYNTAX_ONLY }]

      expect(diff.summary).toMatchObject({
        added: 0,
        removed: 0,
        droppedToggled: 0,
        changed: owners.length + 1,
      })
      expect(changedSymbols(diff)).toMatchObject([
        ...owners,
        { name, apiChanged: true, logicChanged: false, syntaxChanged: true },
      ])
    },
  )
})

describe("an edit to a parameter's modifier or decorator is an api change on its member", () => {
  const service = (parameter: string) =>
    `export class C {\n  constructor(${parameter}) {}\n\n  run() {\n    use()\n  }\n}\n`
  const controller = (parameter: string) =>
    `export class C {\n  find(${parameter}) {\n    use(id)\n  }\n}\n`

  it.each([
    [
      "a parameter property made public",
      service("private s: string"),
      service("public s: string"),
      "C.constructor",
    ],
    [
      "`readonly` dropped",
      service("private readonly s: string"),
      service("private s: string"),
      "C.constructor",
    ],
    [
      "an injection token swapped",
      service("@Inject(A) private s: S"),
      service("@Inject(B) private s: S"),
      "C.constructor",
    ],
    [
      "a route parameter renamed",
      controller('@Param("id") id: string'),
      controller('@Param("key") id: string'),
      "C.find",
    ],
  ])("reports %s", async (_label, before, after, name) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)
    const changed = changedSymbols(diff)

    expect(changed.map((c) => c.name).sort()).toEqual(["C", name])
    expect(changed.find((c) => c.name === name)).toMatchObject({
      apiChanged: true,
      logicChanged: false,
      syntaxChanged: true,
    })
  })
})

describe("an edit to the names a declaration is exported under is an api change", () => {
  it.each([
    [
      "a name added to an export clause",
      "const handler = NextAuth(options)\nexport { handler as GET }\n",
      "const handler = NextAuth(options)\nexport { handler as GET, handler as DELETE }\n",
      "handler",
      { added: ["DELETE"], removed: [] },
    ],
    [
      "a clause renaming its export",
      `${CONNECT}export { connect as open }\n`,
      `${CONNECT}export { connect as start }\n`,
      "connect",
      { added: ["start"], removed: ["open"] },
    ],
    [
      "a default export made a named one",
      `export default ${PAGE}`,
      `export ${PAGE}`,
      "Page",
      { added: ["Page"], removed: ["default"] },
    ],
  ])("reports %s", async (_label, before, after, name, exportedAs) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    expect(changedSymbols(diff)).toMatchObject([
      { name, apiChanged: true, logicChanged: false, exportedAs: { ...exportedAs, modified: [] } },
    ])
  })

  it("keeps the api fingerprint when a clause exports a declaration under its own name, as the keyword does", async () => {
    const { base, head } = await editOf(
      workspace,
      FILE,
      `export ${CONNECT}`,
      `${CONNECT}export { connect }\n`,
    )

    expect(symbolNamed(head, "connect").fingerprint.api).toBe(
      symbolNamed(base, "connect").fingerprint.api,
    )
  })
})

describe("an edit to a parameter's name, pattern, default value or decorator order is a syntax-only change", () => {
  it.each([
    ["a default's value", withParams("limit = 20"), withParams("limit = 10"), ["f"]],
    [
      "a parameter renamed and unused",
      withParams("limit: number"),
      withParams("max: number"),
      ["f"],
    ],
    [
      "the key a destructured parameter reads",
      "export function pick({ a: b }: any) {\n  return b\n}\n",
      "export function pick({ c: b }: any) {\n  return b\n}\n",
      ["pick"],
    ],
    [
      "the hole an array parameter skips",
      "export function second([, b]: any[]) {\n  return b\n}\n",
      "export function second([b]: any[]) {\n  return b\n}\n",
      ["second"],
    ],
    [
      "an arrow's destructured parameter",
      "export const pick = ({ a: b }: any) => b\n",
      "export const pick = ({ c: b }: any) => b\n",
      ["pick"],
    ],
    [
      "a method's destructured parameter, on the method as well as its class",
      "export class C {\n  m({ a: b }: any) {\n    return b\n  }\n}\n",
      "export class C {\n  m({ c: b }: any) {\n    return b\n  }\n}\n",
      ["C", "C.m"],
    ],
    [
      "a constructor's default",
      "export class C {\n  constructor(a = 1) {\n    use(a)\n  }\n}\n",
      "export class C {\n  constructor(a = 2) {\n    use(a)\n  }\n}\n",
      ["C", "C.constructor"],
    ],
    [
      "the order of a constructor parameter's decorators",
      "export class C {\n  constructor(@Optional() @Inject(T) private s: S) {}\n}\n",
      "export class C {\n  constructor(@Inject(T) @Optional() private s: S) {}\n}\n",
      ["C", "C.constructor"],
    ],
    [
      "a setter's parameter, behind the getter that leads the accessor",
      accessor("v"),
      accessor("w"),
      ["C", "C.x"],
    ],
    [
      "the parameter of a class field's function",
      "export class C {\n  h = (a: number) => use()\n}\n",
      "export class C {\n  h = (b: number) => use()\n}\n",
      ["C", "C.h"],
    ],
    [
      "the parameter of an object's method",
      "export const o = {\n  m(a: number) {\n    use()\n  },\n}\n",
      "export const o = {\n  m(b: number) {\n    use()\n  },\n}\n",
      ["o", "o.m"],
    ],
    [
      "the parameter of an object entry's function",
      "export const o = {\n  m: (a: number) => use(),\n}\n",
      "export const o = {\n  m: (b: number) => use(),\n}\n",
      ["o", "o.m"],
    ],
  ])("reports %s", async (_label, before, after, names) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)
    const changed = changedSymbols(diff)

    expect(changed.map((c) => c.name).sort()).toEqual(names)
    for (const c of changed) expect(c).toMatchObject(SYNTAX_ONLY)
  })

  it.each(["src/a.tsx", "src/a.js"])("reads the list alike in %s", async (file) => {
    const diff = await diffOfEdit(
      workspace,
      file,
      "export function f(limit = 20) {\n  use(limit)\n}\n",
      "export function f(limit = 10) {\n  use(limit)\n}\n",
    )

    expect(changedSymbols(diff)).toMatchObject([{ name: "f", ...SYNTAX_ONLY }])
  })
})

describe("an edit to a returned expression is a logic change", () => {
  it("reports a concise arrow and its block spelling alike", async () => {
    const diff = await diffOfEdit(workspace, FILE, perm("admin"), perm("guest"))

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 2 })
    expect(changedSymbols(diff).map((c) => [c.name, c.logicChanged])).toEqual([
      ["canEdit", true],
      ["canEditBlock", true],
    ])
  })
})

describe("an edit to a condition, a case label or a declared value is a logic change", () => {
  it.each([
    [
      "the condition of an `if` that does not leave early",
      "export function grant(user: User): void {\n  if (user.isAdmin) {\n    openVault(user)\n  }\n}\n",
      "export function grant(user: User): void {\n  if (!user.isAdmin) {\n    openVault(user)\n  }\n}\n",
      "grant",
    ],
    ["a loop's bound", sumAll("<"), sumAll("<="), "sumAll"],
    [
      "a `while` loop's condition",
      "export function drain(q: Set<number>): void {\n  while (q.size > 0) take(q)\n}\n",
      "export function drain(q: Set<number>): void {\n  while (q.size > 1) take(q)\n}\n",
      "drain",
    ],
    ["a case label", route('"admin"'), route('"guest"'), "route"],
    [
      "an exported constant's value",
      "export const TIMEOUT_MS = 5000\n",
      "export const TIMEOUT_MS = 5\n",
      "TIMEOUT_MS",
    ],
    [
      "the value of a constant the module keeps to itself",
      "const RETRIES = 3\nexport function f(): void {\n  use(RETRIES)\n}\n",
      "const RETRIES = 5\nexport function f(): void {\n  use(RETRIES)\n}\n",
      "RETRIES",
    ],
    [
      "an entry of an object a constant holds",
      'export const config = { retries: 3, name: "api" }\n',
      'export const config = { retries: 5, name: "api" }\n',
      "config",
    ],
    [
      "an enum member's value",
      colors('Red = "red"', 'Blue = "blue"'),
      colors('Red = "crimson"', 'Blue = "blue"'),
      "Color",
    ],
    ["an enum member's removal", colors("Red", "Blue"), colors("Red"), "Color"],
  ])("reports %s", async (_label, before, after, name) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)

    expect(changedSymbols(diff).map((c) => [c.name, c.apiChanged, c.logicChanged])).toEqual([
      [name, false, true],
    ])
  })

  it("leaves the arguments of a call a constant holds to `syntax`", async () => {
    const diff = await diffOfEdit(
      workspace,
      FILE,
      "export const client = createClient({ retries: 3 })\n",
      "export const client = createClient({ retries: 5 })\n",
    )

    expect(changedSymbols(diff)).toMatchObject([{ name: "client", ...SYNTAX_ONLY }])
  })
})

describe("an edit outside every rule and signature is a syntax-only change", () => {
  it.each([
    [
      "an operator in a statement and a call argument",
      ledger("+", "&&"),
      ledger("-", "||"),
      ["applyCredit", "canDelete"],
    ],
    [
      "a module-level function's retyped overload",
      parser("Buffer"),
      parser("Uint8Array"),
      ["parse"],
    ],
    [
      "a method's removed overload, on the method as well as its class",
      repository("string", "number"),
      repository("string"),
      ["Repository", "Repository.find"],
    ],
    [
      "a field written beside a class's static block",
      registry(),
      registry("static items: string[] = []"),
      ["Registry"],
    ],
    [
      "a renamed `catch` binding a function rethrows",
      "export function load(id: string) {\n  try {\n    return fetchUser(id)\n  } catch (e) {\n    report(e)\n    throw e\n  }\n}\n",
      "export function load(id: string) {\n  try {\n    return fetchUser(id)\n  } catch (error) {\n    report(error)\n    throw error\n  }\n}\n",
      ["load"],
    ],
    [
      "the labels a `break` and a `continue` name swapped",
      firstNegativeRow("inner", "outer"),
      firstNegativeRow("outer", "inner"),
      ["firstNegativeRow"],
    ],
    [
      "the query a concise arrow runs through a tagged template with type arguments",
      "export const count = (db: Db) => db.$queryRaw<Row[]>`select count(*) from a`\n",
      "export const count = (db: Db) => db.$queryRaw<Row[]>`select count(*) from b`\n",
      ["count"],
    ],
    [
      "a concise conditional rewritten as a block that returns it in parentheses",
      "export const larger = (a: number, b: number): number => (a > b ? a : b)\n",
      "export const larger = (a: number, b: number): number => {\n  return (a > b ? a : b)\n}\n",
      ["larger"],
    ],
  ])("reports %s", async (_label, before, after, names) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)
    const changed = changedSymbols(diff)

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: names.length })
    expect(changed.map((c) => c.name).sort()).toEqual(names)
    for (const c of changed) expect(c).toMatchObject(SYNTAX_ONLY)
  })
})

describe("an edit to a member's own modifier moves the member", () => {
  const member = (head: string, rest = "m() {\n    use()\n  }") =>
    `export class C extends B {\n  ${head}${rest}\n}\n`
  const GETTER = "get m() {\n    return use()\n  }"
  const FIELD = "m = () => {\n    use()\n  }"
  const accessorPair = (setterHead: string) =>
    `${GETTER}\n  ${setterHead}set m(v) {\n    use(v)\n  }`

  it.each([
    ["`override` added to a method", member(""), member("override ")],
    ["a method made optional", member(""), member("", "m?() {\n    use()\n  }")],
    ["a method made a getter", member("", "m() {\n    return use()\n  }"), member("", GETTER)],
    ["`override` added to an accessor", member("", GETTER), member("override ", GETTER)],
    [
      "`override` added to the setter of an accessor pair",
      member("", accessorPair("")),
      member("", accessorPair("override ")),
    ],
    [
      "`readonly` added to a field holding a function",
      member("", FIELD),
      member("readonly ", FIELD),
    ],
    [
      "`override` added to a field holding a function",
      member("", FIELD),
      member("override ", FIELD),
    ],
    [
      "a field holding a function made optional",
      member("", FIELD),
      member("", FIELD.replace("m =", "m? =")),
    ],
    [
      "`accessor` added to a field holding a function",
      member("", FIELD),
      member("accessor ", FIELD),
    ],
    [
      "`readonly` added to a field holding a function behind `as`",
      member("", "m = (() => {\n    use()\n  }) as Handler"),
      member("readonly ", "m = (() => {\n    use()\n  }) as Handler"),
    ],
    [
      "`readonly` added to a field holding a function behind `satisfies`",
      member("", "m = (() => {\n    use()\n  }) satisfies Handler"),
      member("readonly ", "m = (() => {\n    use()\n  }) satisfies Handler"),
    ],
  ])("reports %s on the member and its class", async (_label, before, after) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)
    const changed = changedSymbols(diff)

    expect(changed.map((c) => c.name).sort()).toEqual(["C", "C.m"])
    for (const c of changed) expect(c).toMatchObject(SYNTAX_ONLY)
  })
})

describe("an edit inside a part the parser recovered is a syntax-only change", () => {
  it.each([
    [
      "a name in a broken call",
      FILE,
      "export function f() {\n  save(a b)\n}\n",
      "export function f() {\n  save(a c)\n}\n",
    ],
    [
      "a name in a broken return type",
      FILE,
      "export function f(): Map<A B, C> {\n  return m\n}\n",
      "export function f(): Map<A X, C> {\n  return m\n}\n",
    ],
    [
      "a name in a broken class heritage",
      FILE,
      "export class K extends A B {\n  m() {}\n}\n",
      "export class K extends A X {\n  m() {}\n}\n",
    ],
    [
      "the text after a bare `&` in JSX",
      "src/a.tsx",
      "export function F() {\n  render(<p>Subscription & Billing</p>)\n}\n",
      "export function F() {\n  render(<p>Subscription & Invoices</p>)\n}\n",
    ],
  ])("reports %s", async (_label, file, before, after) => {
    const diff = await diffOfEdit(workspace, file, before, after)

    expect(changedSymbols(diff)).toMatchObject([SYNTAX_ONLY])
  })
})

describe("a formatting edit is no change", () => {
  it.each([
    [
      "a lone arrow parameter put in parentheses",
      "export const inc = x => x + 1\n",
      "export const inc = (x) => x + 1\n",
      1,
    ],
    [
      "a lone parameter put in parentheses, on an arrow in a body",
      "export function ids(items: Item[]) {\n  return items.map(x => x.id)\n}\n",
      "export function ids(items: Item[]) {\n  return items.map((x) => x.id)\n}\n",
      1,
    ],
    [
      "a lone parameter put in parentheses, on a class field's arrow",
      "export class C {\n  h = x => use(x)\n}\n",
      "export class C {\n  h = (x) => use(x)\n}\n",
      2,
    ],
    [
      "a lone parameter put in parentheses, on an object entry's arrow",
      "export const o = {\n  m: x => use(x),\n}\n",
      "export const o = {\n  m: (x) => use(x),\n}\n",
      2,
    ],
    [
      "a lone parameter put in parentheses, on an arrow handed to a call",
      "export const handle = wrap(x => {\n  use(x)\n})\n",
      "export const handle = wrap((x) => {\n  use(x)\n})\n",
      1,
    ],
    [
      "a lone parameter put in parentheses, on a registration's handler",
      'app.get("/x", x => {\n  use(x)\n})\n',
      'app.get("/x", (x) => {\n  use(x)\n})\n',
      1,
    ],
    [
      "a trailing comma after the last parameter",
      withParams("a: string, b: number"),
      withParams("a: string, b: number,"),
      1,
    ],
    [
      "a comment written after `throw`",
      get('new NotFound("id")'),
      get('/* legacy path */ new NotFound("id")'),
      1,
    ],
    [
      "comments written into a guard and a return",
      price("", ""),
      price("/* nothing to charge */ ", "/* member discount */ "),
      1,
    ],
    [
      "a union parameter joined onto one line",
      "export function add(\n  provider:\n    | ClassProvider\n    | ValueProvider,\n): void {\n  use(provider)\n}\n",
      "export function add(provider: ClassProvider | ValueProvider): void {\n  use(provider)\n}\n",
      1,
    ],
    [
      "a union parameter of an overload joined onto one line",
      "export function parse(\n  input:\n    | Buffer\n    | string,\n): Config\nexport function parse(input: any): any {\n  return read(input)\n}\n",
      "export function parse(input: Buffer | string): Config\nexport function parse(input: any): any {\n  return read(input)\n}\n",
      1,
    ],
    [
      "an intersection written with a leading `&` joined onto one line",
      "export function add(\n  provider:\n    & Named\n    & Scoped,\n): void {\n  use(provider)\n}\n",
      "export function add(provider: Named & Scoped): void {\n  use(provider)\n}\n",
      1,
    ],
    [
      "a union inside a generic argument joined onto one line",
      "export function add(\n  parts: Array<\n    | ClassProvider\n    | ValueProvider\n  >,\n): void {\n  use(parts)\n}\n",
      "export function add(parts: Array<ClassProvider | ValueProvider>): void {\n  use(parts)\n}\n",
      1,
    ],
    [
      "an object type parameter joined onto one line",
      "export function load(\n  options: {\n    path: string\n    strict?: boolean\n  },\n): void {\n  use(options)\n}\n",
      "export function load(options: { path: string; strict?: boolean }): void {\n  use(options)\n}\n",
      1,
    ],
    [
      "a function type's parameters joined onto one line",
      "export function on(\n  handler: (\n    request: Request,\n    response: Response,\n  ) => void,\n): void {\n  use(handler)\n}\n",
      "export function on(handler: (request: Request, response: Response) => void): void {\n  use(handler)\n}\n",
      1,
    ],
    [
      "a guard re-wrapped over several lines",
      check('user.age < 18 || user.banned || user.role === "guest"'),
      check("", "    user.age < 18 ||", "    user.banned ||", '    user.role === "guest"', "  "),
      1,
    ],
    [
      "a wrapper put around an anonymous default export",
      "export default async (id: string) => {\n  q(id)\n}\n",
      "export default (async (id: string) => {\n  q(id)\n}) satisfies Handler\n",
      1,
    ],
    [
      "the type a wrapped default export satisfies",
      "export default (async () => {\n  q()\n}) satisfies A\n",
      "export default (async () => {\n  q()\n}) satisfies B\n",
      1,
    ],
    [
      "a constructor broken one parameter per line, each decorator above its modifiers",
      "export class Repo {\n  constructor(@Inject(DB) private readonly db: Db, @Optional() private log?: Log) {}\n}\n",
      "export class Repo {\n  constructor(\n    @Inject(DB)\n    private readonly db: Db,\n    @Optional()\n    private log?: Log,\n  ) {}\n}\n",
      2,
    ],
    [
      "a parameter decorator's arguments broken over lines with a trailing comma",
      "export class Repo {\n  constructor(@Inject(DB, { optional: true }) private db: Db) {}\n}\n",
      "export class Repo {\n  constructor(\n    @Inject(\n      DB,\n      {optional: true},\n    )\n    private db: Db,\n  ) {}\n}\n",
      2,
    ],
    [
      "a comment written into a parameter decorator",
      "export class Repo {\n  constructor(@Inject(DB) private db: Db) {}\n}\n",
      "export class Repo {\n  constructor(@Inject(/* legacy */ DB) private db: Db) {}\n}\n",
      2,
    ],
    [
      "a method's union parameter joined onto one line, on the method as well as its class",
      "export class Module {\n  add(\n    provider:\n      | ClassProvider\n      | ValueProvider,\n  ): void {\n    use(provider)\n  }\n}\n",
      "export class Module {\n  add(provider: ClassProvider | ValueProvider): void {\n    use(provider)\n  }\n}\n",
      2,
    ],
  ])(
    "leaves every Symbol unchanged when the only edit is %s",
    async (_label, before, after, unchanged) => {
      const diff = await diffOfEdit(workspace, FILE, before, after)

      expect(diff.symbols).toEqual([])
      expect(diff.summary).toMatchObject({ changed: 0, unchanged })
    },
  )
})

import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { idsOf, normalizedOf, symbolOf, symbolsOf, walkOf } from "./fixtures/ctx"
import { scanWithoutWarnings } from "./fixtures/scan"

const TWO_ENUMS = ["export enum E { A }", "export enum E { B }"].join("\n")

const CLASS_AND_NAMESPACE = "export class C {}\nexport namespace C { export const a = 1 }"

const INTERFACE = "export interface P { extra(): void }"

const CLASS = "export class P {\n  on() { go() }\n}"

const CLASS_AND_NAMESPACE_MEMBER = [
  "export class C {",
  "  m(a: string) { inner(a) }",
  "}",
  "export namespace C {",
  "  export function m(b: number) { other(b) }",
  "}",
].join("\n")

describe("merged declarations are one Symbol", () => {
  it.each([
    [
      "two namespaces",
      "export namespace N { export const a = 1 }\nexport namespace N { export const b = 2 }",
      ["ts:src/a.ts#N", "ts:src/a.ts#N.a", "ts:src/a.ts#N.b"],
    ],
    [
      "three namespaces",
      "export namespace N {}\nexport namespace N {}\nexport namespace N {}",
      ["ts:src/a.ts#N"],
    ],
    [
      "two interfaces",
      "export interface I { a: string }\nexport interface I { b: string }",
      ["ts:src/a.ts#I"],
    ],
    ["two enums", TWO_ENUMS, ["ts:src/a.ts#E"]],
    ["a class and a namespace", CLASS_AND_NAMESPACE, ["ts:src/a.ts#C", "ts:src/a.ts#C::a"]],
    [
      "a function and a namespace",
      "export function g() {}\nexport namespace g { export const a = 1 }",
      ["ts:src/a.ts#g", "ts:src/a.ts#g.a"],
    ],
    ["an interface and a class", "export interface P {}\nexport class P {}", ["ts:src/a.ts#P"]],
  ])("emits one Symbol for %s", async (_label, source, ids) => {
    expect(await idsOf(source)).toEqual(ids)
  })

  it("gives the merged Symbol the first declaration's kind and range, and every rationale", async () => {
    const symbol = await symbolOf(CLASS_AND_NAMESPACE, "ts:src/a.ts#C")

    expect([symbol.kind, symbol.source.startLine]).toEqual(["class", 1])
    expect(symbol.derivedBy).toEqual([
      "export-keyword",
      "namespace-declaration",
      "declaration-merged",
    ])
  })

  it("keeps the leading declaration's visibility when a merge disagrees about the export", async () => {
    const symbol = await symbolOf(
      "interface I { a: 1 }\nexport interface I { b: 2 }",
      "ts:src/a.ts#I",
    )

    expect(symbol.visibility).toBe("internal")
    expect(symbol.derivedBy).toContain("export-keyword")
  })

  it("puts a reopened enum's members into the fingerprint input", async () => {
    const one = await normalizedOf("export enum E { A }", "ts:src/a.ts#E")
    const two = await normalizedOf(TWO_ENUMS, "ts:src/a.ts#E")
    const other = await normalizedOf(TWO_ENUMS.replace("B", "ZZZ"), "ts:src/a.ts#E")

    expect(two).not.toBe(one)
    expect(two).not.toBe(other)
  })

  it("keeps an instance member apart from a namespace export of the same name", async () => {
    const method = await symbolOf(CLASS_AND_NAMESPACE_MEMBER, "ts:src/a.ts#C.m")
    const exported = await symbolOf(CLASS_AND_NAMESPACE_MEMBER, "ts:src/a.ts#C::m")

    expect(await idsOf(CLASS_AND_NAMESPACE_MEMBER)).toEqual([
      "ts:src/a.ts#C",
      "ts:src/a.ts#C.m",
      "ts:src/a.ts#C::m",
    ])
    expect([method.kind, method.source.startLine]).toEqual(["method", 2])
    expect([exported.kind, exported.source.startLine]).toEqual(["function", 5])
    expect(
      (await walkOf(CLASS_AND_NAMESPACE_MEMBER, "ts:src/a.ts#C.m")).calls.map((c) => c.line),
    ).toEqual([2])
    expect(
      (await walkOf(CLASS_AND_NAMESPACE_MEMBER, "ts:src/a.ts#C::m")).calls.map((c) => c.line),
    ).toEqual([5])
  })

  it("does not walk a merged namespace, whose statements are Symbols of their own", async () => {
    const source = "export class C {}\nexport namespace C {\n  export function go() { inner() }\n}"

    expect((await walkOf(source, "ts:src/a.ts#C")).calls).toEqual([])
    expect((await walkOf(source, "ts:src/a.ts#C::go")).calls.map((c) => c.target)).toEqual([
      "inner",
    ])
  })

  it("says nothing about merging on a file that merges nothing", async () => {
    const symbols = await symbolsOf(
      [
        "export class A { m() {} }",
        "export interface I {}",
        "app.get('/x', () => {})",
        "export const w = withAuth(handler)",
        "export const o = { m() {}, f: () => {}, get g() { return 1 } }",
      ].join("\n"),
    )

    for (const symbol of symbols) {
      expect(symbol.derivedBy).not.toContain("declaration-merged")
      expect("mergedDeclarations" in symbol).toBe(false)
    }
  })
})

describe("a class leads the declarations merged with it, whichever is written first", () => {
  const HELD_CLASS = "export const P = class {\n  on() { go() }\n}"

  it.each([
    ["after an interface", [INTERFACE, CLASS], [2, 4]],
    ["before an interface", [CLASS, INTERFACE], [1, 3]],
    [
      "after a type alias, held by a binding",
      ["export type P = InstanceType<typeof P>", HELD_CLASS],
      [2, 4],
    ],
  ])("takes the kind and range of a class written %s", async (_label, declarations, lines) => {
    const symbol = await symbolOf(declarations.join("\n"), "ts:src/a.ts#P")

    expect([symbol.kind, symbol.source.startLine, symbol.source.endLine]).toEqual([
      "class",
      ...lines,
    ])
    expect(symbol.mergedDeclarations).toHaveLength(1)
    expect(symbol.derivedBy).toContain("declaration-merged")
  })

  it("keeps the decorators of a class an interface was declared before", async () => {
    const source = [INTERFACE, "@Controller()", CLASS].join("\n")
    const symbol = await symbolOf(source, "ts:src/a.ts#P")

    expect(symbol.kind).toBe("class")
    expect(symbol.decorators.map((d) => d.name)).toEqual(["Controller"])
  })

  it("moves the class's normalized string with an edit to the interface written before it", async () => {
    const before = await normalizedOf([INTERFACE, CLASS].join("\n"), "ts:src/a.ts#P")
    const after = await normalizedOf(
      [INTERFACE.replace("extra", "other"), CLASS].join("\n"),
      "ts:src/a.ts#P",
    )

    expect(after).not.toBe(before)
  })

  it("leaves interfaces merged with nothing else an interface", async () => {
    const symbol = await symbolOf(`${INTERFACE}\n${INTERFACE}`, "ts:src/a.ts#P")

    expect(symbol.kind).toBe("interface")
  })
})

describe("what else exists at run time leads an interface or a type written before it", () => {
  it.each([
    [
      "a binding below a type alias",
      "export type User = ReturnType<typeof User>\nexport const User = make({ a: 1 })",
      "const",
    ],
    [
      "a function below an interface",
      "export interface User { extra: number }\nexport function User() { go() }",
      "function",
    ],
    ["an enum below a type alias", "export type User = 1\nexport enum User { A }", "enum"],
    [
      "a namespace below an interface",
      "export interface User { extra: number }\nexport namespace User { export const a = 1 }",
      "namespace",
    ],
    [
      "a function below a namespace",
      "namespace User { export const a = 1 }\nfunction User() { go() }",
      "function",
    ],
  ])("takes the kind and range of %s", async (_label, source, kind) => {
    const symbol = await symbolOf(source, "ts:src/a.ts#User")

    expect([symbol.kind, symbol.source.startLine]).toEqual([kind, 2])
    expect(symbol.derivedBy).toContain("declaration-merged")
  })

  it.each([
    [
      "the first written of two at one rank",
      "export enum User { A }\nexport enum User { B = 1 }",
      ["enum", 1],
    ],
    [
      "an overloaded function's implementation, past its overloads",
      "export interface User { extra: number }\nexport function User(a: string): void\nexport function User(a: any) { go() }",
      ["function", 3],
    ],
  ])("takes the kind and range of %s", async (_label, source, lead) => {
    const symbol = await symbolOf(source, "ts:src/a.ts#User")

    expect([symbol.kind, symbol.source.startLine]).toEqual(lead)
  })

  it("leaves a function-led merge `internal` under a type-only export clause", async () => {
    const source =
      "interface User { extra: number }\nfunction User() { go() }\nexport type { User }"

    expect((await symbolOf(source, "ts:src/a.ts#User")).visibility).toBe("internal")
  })
})

describe("scan — a function or a binding an interface or a type is written above", () => {
  const workspace = useScratchWorkspace("value-below-type")

  it.each([
    [
      "a binding below a type alias",
      "export type User = ReturnType<typeof User>\nexport const User = make({ a: 1 })",
      ["make"],
    ],
    [
      "a function below an interface",
      "export interface User { extra: number }\nexport function User() { go() }",
      ["go"],
    ],
  ])("keeps %s, with its calls, and resolves a call to it", async (_label, source, calls) => {
    const use = "export function use() {\n  User()\n}"
    await workspace.writeSource("src/a.ts", `${source}\n${use}\n`)
    const ir = await scanWithoutWarnings(workspace.root)
    const user = symbolById({ ir }, "ts:src/a.ts#User")

    expect([user.dropped, user.calls.map((c) => c.target)]).toEqual([false, calls])
    expect(symbolById({ ir }, "ts:src/a.ts#use").calls.map((c) => [c.target, c.resolved])).toEqual([
      ["User", "ts:src/a.ts#User"],
    ])
  })
})

describe("scan — a class merged with an interface", () => {
  const workspace = useScratchWorkspace("class-and-interface")

  it.each([
    ["after", [INTERFACE, CLASS]],
    ["before", [CLASS, INTERFACE]],
  ])(
    "keeps a class written %s its interface, and resolves `new` to it",
    async (_label, declarations) => {
      const use = ["export function use() {", "  new P()", "}"]
      await workspace.writeSource("src/a.ts", [...declarations, ...use, ""].join("\n"))
      const ir = await scanWithoutWarnings(workspace.root)
      const { kind, dropped } = symbolById({ ir }, "ts:src/a.ts#P")

      expect([kind, dropped]).toEqual(["class", false])
      expect(
        symbolById({ ir }, "ts:src/a.ts#use").calls.map((c) => [c.target, c.resolved]),
      ).toEqual([["P", "ts:src/a.ts#P"]])
    },
  )
})

describe("a namespace merged into a class declares static members", () => {
  it.each([
    [
      "an unexported statement, which is local to the namespace",
      "export class C {}\nexport namespace C { const local = 1; export const a = 2 }",
      ["ts:src/a.ts#C", "ts:src/a.ts#C.local", "ts:src/a.ts#C::a"],
    ],
    [
      "a nested namespace and its body",
      "export class C {}\nexport namespace C { export namespace Inner { export function g() {} } }",
      ["ts:src/a.ts#C", "ts:src/a.ts#C::Inner", "ts:src/a.ts#C::Inner.g"],
    ],
    [
      "a nested class and its members",
      "export class C {}\nexport namespace C { export class K { m() {} static s() {} } }",
      ["ts:src/a.ts#C", "ts:src/a.ts#C::K", "ts:src/a.ts#C::K.m", "ts:src/a.ts#C::K::s"],
    ],
    [
      "a dotted namespace, whose later segments are exported by the head",
      "export class C {}\nnamespace C.D { const x = 1 }",
      ["ts:src/a.ts#C", "ts:src/a.ts#C::D", "ts:src/a.ts#C::D.x"],
    ],
    [
      "an ambient namespace, which exports without the keyword",
      "declare class C { m(): void }\ndeclare namespace C { function m(): void }",
      ["ts:src/a.ts#C", "ts:src/a.ts#C.m", "ts:src/a.ts#C::m"],
    ],
    [
      "a class written after the namespace",
      "namespace C { export const a = 1 }\nclass C {}",
      ["ts:src/a.ts#C", "ts:src/a.ts#C::a"],
    ],
    [
      "an unexported namespace",
      "export class C {}\nnamespace C { export const a = 1 }\n",
      ["ts:src/a.ts#C", "ts:src/a.ts#C::a"],
    ],
    [
      "a default-exported class",
      "export default class C {}\nexport namespace C { export const a = 1 }",
      ["ts:src/a.ts#C", "ts:src/a.ts#C::a"],
    ],
    [
      "an abstract class and namespace inside another namespace",
      "namespace A { export abstract class C { m() {} } export namespace C { export function m() {} } }",
      ["ts:src/a.ts#A", "ts:src/a.ts#A.C", "ts:src/a.ts#A.C.m", "ts:src/a.ts#A.C::m"],
    ],
    [
      "a class beside a namespace, and a second block with its own class of the same name",
      "export class C {}\nnamespace A { export namespace C { export const x = 1 } }\nnamespace B { export class C {} export namespace C { export const y = 1 } }",
      [
        "ts:src/a.ts#A",
        "ts:src/a.ts#A.C",
        "ts:src/a.ts#A.C.x",
        "ts:src/a.ts#B",
        "ts:src/a.ts#B.C",
        "ts:src/a.ts#B.C::y",
        "ts:src/a.ts#C",
      ],
    ],
    [
      "a class merged inside a merged namespace",
      "class C {}\nnamespace C { export class D {} export namespace D { export const x = 1 } }",
      ["ts:src/a.ts#C", "ts:src/a.ts#C::D", "ts:src/a.ts#C::D::x"],
    ],
    [
      "an overloaded export",
      "export class C {}\nexport namespace C {\n export function m(a: string): void\n export function m(a: any) {}\n}",
      ["ts:src/a.ts#C", "ts:src/a.ts#C::m"],
    ],
    [
      "an exported binding's object members",
      "export class C {}\nexport namespace C { export const api = { get() { q() } } }",
      ["ts:src/a.ts#C", "ts:src/a.ts#C::api", "ts:src/a.ts#C::api.get"],
    ],
  ])("spells %s", async (_label, source, ids) => {
    expect(await idsOf(source)).toEqual(ids)
  })

  it.each([
    ["an interface", "export interface C {}"],
    ["an enum", "export enum C { A }"],
    ["a function", "export function C() {}"],
    ["a class in another namespace", "namespace X { export class C {} }"],
  ])("keeps the dot where the namespace merges into %s", async (_label, declaration) => {
    const ids = await idsOf(`${declaration}\nexport namespace C { export const a = 1 }`)

    expect(ids).toContain("ts:src/a.ts#C.a")
    expect(ids.some((id) => id.includes("::"))).toBe(false)
  })

  it("keeps the dot for a class declared inside the namespace's own body", async () => {
    const source = "export namespace C { export class C {} export const a = 1 }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.C", "ts:src/a.ts#C.a"])
  })

  it("keeps the dot when the class is in another block of a reopened outer namespace", async () => {
    // A limit, not the intent: TypeScript merges these, and one block would give `A.C::x`.
    const source =
      "namespace A { export class C {} }\nnamespace A { export namespace C { export const x = 1 } }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#A", "ts:src/a.ts#A.C", "ts:src/a.ts#A.C.x"])
  })

  it("marks a local internal, and an export as static by its `::` alone", async () => {
    const source = "export class C {}\nexport namespace C { const local = 1; export const a = 2 }"
    const described = (await symbolsOf(source)).map((s) => [s.id, s.visibility, s.derivedBy])

    expect(described.slice(1)).toEqual([
      ["ts:src/a.ts#C.local", "internal", []],
      ["ts:src/a.ts#C::a", "public", ["export-keyword"]],
    ])
  })

  it("folds a static member into the namespace export of the same name, which tsc refuses as a duplicate", async () => {
    const source = "export class C { static m() {} }\nexport namespace C { export function m() {} }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C::m"])
  })

  it("folds a static member and an exported type of the same name, as a value and a type fold", async () => {
    const source =
      "export class C { static m() { helper() } }\nexport namespace C { export type m = string }"
    const m = await symbolOf(source, "ts:src/a.ts#C::m")

    expect([m.kind, m.derivedBy]).toEqual([
      "method",
      ["static-method", "type-alias", "export-keyword", "declaration-merged"],
    ])
  })

  it.each([
    ["overloads", "export class C { static m(a: string): void; static m(a: any) {} }"],
    ["an accessor pair", "export class C { static get m() { return 1 } static set m(v) {} }"],
  ])(
    "says declaration-merged once when a member folded from %s meets an exported type",
    async (_label, member) => {
      const m = await symbolOf(
        `${member}\nexport namespace C { export type m = number }`,
        "ts:src/a.ts#C::m",
      )

      expect(m.mergedDeclarations).toHaveLength(2)
      expect(m.derivedBy.filter((token) => token === "declaration-merged")).toHaveLength(1)
    },
  )

  it("still folds an instance member and a namespace local of the same name", async () => {
    const source = "export class C { m() { helper() } }\nexport namespace C { const m = 1 }"
    const m = await symbolOf(source, "ts:src/a.ts#C.m")

    expect([m.kind, m.derivedBy]).toEqual(["method", ["class-method", "declaration-merged"]])
  })
})

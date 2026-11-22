import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { normalizedOf, symbolOf } from "./fixtures/ctx"

const stringOf = (source: string, id = "ts:src/a.ts#C") => normalizedOf(source, id)

const BODY = "{ run() { go() } }"

describe("normalizeAst — a class's head", () => {
  it.each([
    [
      "a re-parent",
      `export class C extends Base ${BODY}`,
      `export class C extends Audited ${BODY}`,
    ],
    ["dropping extends", `export class C extends Base ${BODY}`, `export class C ${BODY}`],
    [
      "swapping the interface it implements",
      `export class C implements Reader ${BODY}`,
      `export class C implements Writer ${BODY}`,
    ],
    [
      "a new type parameter",
      `export class C<T> ${BODY}`,
      `export class C<T, K extends keyof T> ${BODY}`,
    ],
    ["dropping abstract", `export abstract class C ${BODY}`, `export class C ${BODY}`],
    [
      "a re-parent of a class merged behind an interface",
      `export interface C { z: number }\nexport class C extends Base ${BODY}`,
      `export interface C { z: number }\nexport class C extends Audited ${BODY}`,
    ],
    [
      "adding abstract to a class merged behind an interface",
      `export interface C { z: number }\nexport class C ${BODY}`,
      `export interface C { z: number }\nexport abstract class C ${BODY}`,
    ],
  ])("changes the string for %s", async (_label, before, after) => {
    expect(await stringOf(after)).not.toBe(await stringOf(before))
  })

  it("changes the string for a re-parent of an anonymous default class, an expression node", async () => {
    const id = "ts:src/a.ts#<default>"
    expect(await stringOf(`export default class extends Audited ${BODY}`, id)).not.toBe(
      await stringOf(`export default class extends Base ${BODY}`, id),
    )
  })

  it("follows the body with the head, in the order the declaration writes it", async () => {
    const source = `export abstract class C<T> extends Base<T> implements Reader, Writer ${BODY}`
    expect(await stringOf(source)).toBe(
      [
        '(class_body (method_definition (property_identifier "run") (formal_parameters) (statement_block (expression_statement (call_expression (identifier "go") (arguments))))))',
        '"abstract"',
        '(type_parameters "<" (type_parameter (type_identifier "T")) ">")',
        '(class_heritage (extends_clause "extends" (identifier "Base") (type_arguments "<" (type_identifier "T") ">")) (implements_clause "implements" (type_identifier "Reader") (type_identifier "Writer")))',
      ].join(" "),
    )
  })

  it("leaves a class with no head described by its body alone", async () => {
    const symbol = await symbolOf(`export class C ${BODY}`, "ts:src/a.ts#C")
    if (symbol.bodyNode === null) throw new Error("class body missing")
    const bodyOnly = normalizeAst({ ...symbol, fullNode: symbol.bodyNode })
    expect(normalizeAst(symbol)).toBe(bodyOnly)
  })
})

describe("a class names the class it extends", () => {
  it.each([
    ["a name", `export class C extends Base ${BODY}`, "ts:src/a.ts#C", "Base"],
    [
      "an imported name with type arguments",
      `import { Base } from "./base"\nexport class C extends Base<string> ${BODY}`,
      "ts:src/a.ts#C",
      "Base",
    ],
    [
      "a namespace import's member",
      `import * as ns from "./base"\nexport class C extends ns.Base<string> ${BODY}`,
      "ts:src/a.ts#C",
      "ns.Base",
    ],
    [
      "a class a binding holds",
      `export const C = class extends Base ${BODY}`,
      "ts:src/a.ts#C",
      "Base",
    ],
    [
      "an anonymous default class",
      `export default class extends Base ${BODY}`,
      "ts:src/a.ts#<default>",
      "Base",
    ],
    [
      "a namespace's class extending a class the module declares",
      `class Base {}\nexport namespace N {\n  export class C extends Base ${BODY}\n}`,
      "ts:src/a.ts#N.C",
      "Base",
    ],
  ])("as the module binds it, through %s", async (_label, source, id, superclass) => {
    expect((await symbolOf(source, id)).superclass).toBe(superclass)
  })

  it.each([
    ["no `extends`", `export class C implements Reader ${BODY}`, "ts:src/a.ts#C"],
    ["a call", `export class C extends mixin(Base) ${BODY}`, "ts:src/a.ts#C"],
    [
      "a class the namespace declares",
      `export namespace N {\n  class Base {}\n  export class C extends Base ${BODY}\n}`,
      "ts:src/a.ts#N.C",
    ],
  ])("is absent for %s", async (_label, source, id) => {
    expect(await symbolOf(source, id)).not.toHaveProperty("superclass")
  })
})

describe("a class that extends another names the instance members it declares itself", () => {
  it("as each spelling of one declares or assigns it, a Symbol or not, but no field written only for its type", async () => {
    const source = [
      "export abstract class C extends Base {",
      "  static make() { this.made = 1 }",
      "  static shared = 1",
      "  find() {}",
      "  get size() { return 1 }",
      "  table = 'users'",
      "  #secret = 1",
      "  'quoted' = 2",
      "  [computed] = 3",
      "  @Input() injected!: Repo",
      "  accessor stored: Repo",
      "  abstract pending: Repo",
      "  untyped",
      "  narrowed!: Base['narrowed']",
      "  declare typed: Repo",
      "  optional?: Repo",
      "  assigned!: Repo",
      "  init() { this.assigned = make() }",
      "  handler = () => { this.fromArrow = 1 }",
      "  callback = function () { this.ownThis = 1 }",
      "  constructor(private readonly repo: Repo, plain: number) {",
      "    super()",
      "    this.cache = new Map()",
      "    if (plain) this.count ??= 0",
      "    const later = () => { this.late = 1 }",
      "    function own() { this.ignored = 1 }",
      "  }",
      "}",
    ].join("\n")
    expect((await symbolOf(source, "ts:src/a.ts#C")).instanceMembers).toEqual([
      "find",
      "size",
      "table",
      "#secret",
      "quoted",
      "injected",
      "stored",
      "pending",
      "untyped",
      "init",
      "assigned",
      "handler",
      "fromArrow",
      "callback",
      "repo",
      "cache",
      "count",
      "late",
    ])
  })

  it("names none for a class that extends nothing", async () => {
    expect(await symbolOf(`export class C ${BODY}`, "ts:src/a.ts#C")).not.toHaveProperty(
      "instanceMembers",
    )
  })
})

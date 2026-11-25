import { normalizeRuleText } from "@aburi/core"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { symbolOf, walkOf } from "./fixtures/ctx"
import { changedSymbols, diffOfEdit } from "./fixtures/scan"

const workspace = useScratchWorkspace("formatter-spellings")

const controller = (route: string, param: string, guards: string) =>
  [
    `@Controller(${route})`,
    "export class UsersController {",
    `  @Get(${param})`,
    `  @UseGuards(${guards})`,
    `  find(@Param(${param}) id: string) {`,
    "    return this.users.find(id)",
    "  }",
    "}",
    "",
  ].join("\n")

describe("a spelling a formatter chooses moves no fingerprint", () => {
  it.each([
    [
      "the quotes in a guard and a thrown value",
      "src/a.ts",
      "export function check(role: string) {\n  if (role === 'admin') throw new Error('no')\n}\n",
      'export function check(role: string) {\n  if (role === "admin") throw new Error("no")\n}\n',
    ],
    [
      "the quotes in a string literal type",
      "src/a.ts",
      "export function setMode(mode: 'fast' | 'slow'): 'ok' {\n  return apply(mode)\n}\n",
      'export function setMode(mode: "fast" | "slow"): "ok" {\n  return apply(mode)\n}\n',
    ],
    [
      "a returned object joined onto one line, dropping its trailing comma",
      "src/a.ts",
      "export function shape(a: number, b: number) {\n  return {\n    total: a + b,\n    diff: a - b,\n  }\n}\n",
      "export function shape(a: number, b: number) {\n  return { total: a + b, diff: a - b }\n}\n",
    ],
    [
      "the parentheses around an arrow's lone parameter",
      "src/a.ts",
      "export function anyBig(xs: number[]) {\n  if (xs.some(x => x > 1)) return true\n  return false\n}\n",
      "export function anyBig(xs: number[]) {\n  if (xs.some((x) => x > 1)) return true\n  return false\n}\n",
    ],
    [
      "the spacing inside a type",
      "src/a.ts",
      "export function index(m: Record<string,number>, cb: (a:string)=>void): Promise<A|null> {\n  return lookup(m, cb)\n}\n",
      "export function index(m: Record<string, number>, cb: (a: string) => void): Promise<A | null> {\n  return lookup(m, cb)\n}\n",
    ],
    [
      "the spacing between a condition's operands",
      "src/a.ts",
      "export function f(a: number, b: number) {\n  if (a<0||b>1) throw new RangeError()\n}\n",
      "export function f(a: number, b: number) {\n  if (a < 0 || b > 1) throw new RangeError()\n}\n",
    ],
    [
      "the quotes in a class's, a method's and a parameter's decorators",
      "src/a.ts",
      controller("'users'", "':id'", "AuthGuard"),
      controller('"users"', '":id"', "AuthGuard"),
    ],
    [
      "a decorator's arguments broken over lines with a trailing comma",
      "src/a.ts",
      controller('"users"', '":id"', "AuthGuard, RoleGuard"),
      controller('"users"', '":id"', "\n    AuthGuard,\n    RoleGuard,\n  "),
    ],
    [
      "a comment inside a decorator's arguments",
      "src/a.ts",
      controller('"users"', '":id"', "AuthGuard"),
      controller('"users"', '":id"', "/* legacy */ AuthGuard"),
    ],
    [
      "the semicolons ending a callback's statements",
      "src/a.ts",
      "export function f(xs: number[]) {\n  if (xs.some((x) => { const y = g(x); return y > 1; })) throw new E()\n}\n",
      "export function f(xs: number[]) {\n  if (\n    xs.some((x) => {\n      const y = g(x)\n      return y > 1\n    })\n  ) throw new E()\n}\n",
    ],
    [
      "JSX children laid out over lines",
      "src/a.tsx",
      "export function View(p: { name: string }) {\n  if (!p.name) return null\n  return <div><p>Hello {p.name}</p></div>\n}\n",
      "export function View(p: { name: string }) {\n  if (!p.name) return null\n  return <div>\n    <p>Hello {p.name}</p>\n  </div>\n}\n",
    ],
    [
      "the parentheses around JSX laid out over lines",
      "src/a.tsx",
      "export function View(p: { a: boolean; xs: string[] }) {\n  if (!p.xs) return <i>none</i>\n  return p.a ? p.xs.map((x) => <li>{x}</li>) : <i>y</i>\n}\n",
      "export function View(p: { a: boolean; xs: string[] }) {\n  if (!p.xs) return (\n    <i>none</i>\n  )\n  return p.a ? (\n    p.xs.map((x) => (\n      <li>{x}</li>\n    ))\n  ) : (\n    <i>y</i>\n  )\n}\n",
    ],
    [
      "the parentheses around a returned call and a returned conditional",
      "src/a.ts",
      "export function total(a: number, b: number) {\n  return compute(a, b)\n}\nexport function larger(a: number, b: number) {\n  return a > b ? a : b\n}\n",
      "export function total(a: number, b: number) {\n  return (\n    compute(a, b)\n  )\n}\nexport function larger(a: number, b: number) {\n  return (a > b ? a : b)\n}\n",
    ],
    [
      "the parentheses that spell out a precedence",
      "src/a.ts",
      "export function f(a: boolean, b: boolean, c: number) {\n  if (a && b || c % 2 * 3 > 1) throw new E()\n}\n",
      "export function f(a: boolean, b: boolean, c: number) {\n  if ((a && b) || ((c % 2) * 3) > 1) throw new E()\n}\n",
    ],
    [
      "the letter case and zeros of a number",
      "src/a.ts",
      "export function f(a: number) {\n  if (a > 1.50 || a === 0XFF || a < .5E+01) throw new E()\n}\n",
      "export function f(a: number) {\n  if (a > 1.5 || a === 0xff || a < 0.5e1) throw new E()\n}\n",
    ],
    [
      "the quotes around a property key",
      "src/a.ts",
      "export function f(a: number) {\n  if (a < 0) throw new E({ 'code': a, 'max-age': 1 })\n}\n",
      'export function f(a: number) {\n  if (a < 0) throw new E({ code: a, "max-age": 1 })\n}\n',
    ],
    [
      "the spacing inside a template's substitution",
      "src/a.ts",
      `export function f(a: number) {\n  if (a < 0) throw new Error(\`bad \${ a+1 }\`)\n}\n`,
      `export function f(a: number) {\n  if (a < 0) throw new Error(\`bad \${a + 1}\`)\n}\n`,
    ],
    [
      "a string's quotes and the escapes they take",
      "src/a.ts",
      String.raw`export function f(s: string) {
  if (s === 'it\'s' || s === "a\"b") throw new E('x')
}
`,
      `export function f(s: string) {
  if (s === "it's" || s === 'a"b') throw new E("x")
}
`,
    ],
    [
      "the semicolons ending an early return inside a callback",
      "src/a.ts",
      "export function f(xs: any[]) {\n  if (xs.some((x) => { if (!x) return false; return x.ok; })) throw new E();\n}\n",
      "export function f(xs: any[]) {\n  if (xs.some((x) => { if (!x) return false\n    return x.ok })) throw new E()\n}\n",
    ],
    [
      "a `new` written without its argument list",
      "src/a.ts",
      "export function f(a: number) {\n  if (a < 0) throw new RangeError\n  return new Map\n}\n",
      "export function f(a: number) {\n  if (a < 0) throw new RangeError()\n  return new Map()\n}\n",
    ],
    [
      "the parentheses around an operand, an index, a `case` value, a loop's collection and a type",
      "src/a.ts",
      "export function f(a: any, xs: (A)[]) {\n  if (!(!a) || a[(0)] || (new A()).b) return\n  for (const x of (xs)) g(x)\n  switch (a) {\n    case (1):\n      return (a) as B\n  }\n}\n",
      "export function f(a: any, xs: A[]) {\n  if (!!a || a[0] || new A().b) return\n  for (const x of xs) g(x)\n  switch (a) {\n    case 1:\n      return a as B\n  }\n}\n",
    ],
    [
      "the parentheses around what `export default` holds",
      "src/a.ts",
      "export default (makeRouter({ a: 1 }))\n",
      "export default makeRouter({ a: 1 })\n",
    ],
    [
      "the quotes around a key that needs none, wherever a key is written",
      "src/a.ts",
      "export interface I { 'a': string }\nexport class K {\n  'f' = 1\n  'm'() { return 1 }\n}\nexport enum E { 'X' = 1 }\nexport function g(o: any) {\n  const { 'p': q } = o\n  return h(q)\n}\n",
      "export interface I { a: string }\nexport class K {\n  f = 1\n  m() { return 1 }\n}\nexport enum E { X = 1 }\nexport function g(o: any) {\n  const { p: q } = o\n  return h(q)\n}\n",
    ],
    [
      "JSX text re-wrapped over lines",
      "src/a.tsx",
      "export function View(p: { a: boolean }) {\n  if (!p.a) return null\n  return <p>Some long text here</p>\n}\n",
      "export function View(p: { a: boolean }) {\n  if (!p.a) return null\n  return (\n    <p>\n      Some long\n      text here\n    </p>\n  )\n}\n",
    ],
    [
      'the `{" "}` a formatter writes where it breaks JSX after meaningful text',
      "src/a.tsx",
      "export function View(p: { name: string; a: string; b: string }) {\n  if (!p.name) return <p>{p.a} {p.b}</p>\n  return <p>Hello <b>{p.name}</b></p>\n}\n",
      'export function View(p: { name: string; a: string; b: string }) {\n  if (!p.name)\n    return (\n      <p>\n        {p.a}{" "}\n        {p.b}\n      </p>\n    )\n  return (\n    <p>\n      Hello{" "}\n      <b>{p.name}</b>\n    </p>\n  )\n}\n',
    ],
    [
      "the quotes around a JSX attribute's value",
      "src/a.tsx",
      "export function View(p: { a: boolean }) {\n  if (!p.a) return null\n  return <a href='/x'>x</a>\n}\n",
      'export function View(p: { a: boolean }) {\n  if (!p.a) return null\n  return <a href="/x">x</a>\n}\n',
    ],
  ])("%s", async (_label, file, before, after) => {
    const diff = await diffOfEdit(workspace, file, before, after)

    expect(changedSymbols(diff)).toEqual([])
    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 0 })
  })
})

describe("an edit to what the code says still moves one", () => {
  it.each([
    [
      "the text between JSX tags, written as a call's argument",
      "export function Card() {\n  render(<button>Delete</button>)\n}\n",
      "export function Card() {\n  render(<button>Remove</button>)\n}\n",
      { apiChanged: false, logicChanged: false, syntaxChanged: true },
    ],
    [
      "the text between JSX tags, in a returned element",
      "export function Card() {\n  return <button>Delete</button>\n}\n",
      "export function Card() {\n  return <button>Remove</button>\n}\n",
      { apiChanged: false, logicChanged: true, syntaxChanged: true },
    ],
    [
      "the grouping of an expression",
      "export function f(a: number, b: number) {\n  if (a + b * 2 > 1) throw new E()\n}\n",
      "export function f(a: number, b: number) {\n  if ((a + b) * 2 > 1) throw new E()\n}\n",
      { apiChanged: false, logicChanged: true, syntaxChanged: true },
    ],
    [
      "a negation of a negation made a decrement",
      "export function f(a: number) {\n  if (- -a > 0) throw new E()\n}\n",
      "export function f(a: number) {\n  if (--a > 0) throw new E()\n}\n",
      { apiChanged: false, logicChanged: true, syntaxChanged: true },
    ],
    [
      "the line break after a character reference",
      "export function Card() {\n  return <p>a&nbsp;\n    b</p>\n}\n",
      "export function Card() {\n  return <p>a&nbsp;b</p>\n}\n",
      { apiChanged: false, logicChanged: true, syntaxChanged: true },
    ],
    [
      "the character a reference names",
      "export function Card() {\n  return <p>&amp;</p>\n}\n",
      "export function Card() {\n  return <p>&lt;</p>\n}\n",
      { apiChanged: false, logicChanged: true, syntaxChanged: true },
    ],
    [
      "the parentheses that stop an optional chain",
      "export function f(a: any) {\n  if ((a?.b.c).d) throw new E()\n}\n",
      "export function f(a: any) {\n  if (a?.b.c.d) throw new E()\n}\n",
      { apiChanged: false, logicChanged: true, syntaxChanged: true },
    ],
    [
      "the parentheses a non-null assertion stops an optional chain with",
      "export function f(a: any, x: boolean) {\n  if (x || (a?.b)!.c) throw new E()\n}\n",
      "export function f(a: any, x: boolean) {\n  if (x || a?.b!.c) throw new E()\n}\n",
      { apiChanged: false, logicChanged: true, syntaxChanged: true },
    ],
  ])("%s", async (_label, before, after, delta) => {
    const diff = await diffOfEdit(workspace, "src/a.tsx", before, after)

    expect(changedSymbols(diff)).toMatchObject([delta])
  })
})

describe("the one spelling the IR records", () => {
  it("writes a rule with double quotes, regenerated spacing and no trailing separator", async () => {
    const { rules } = await walkOf(
      "export function f(xs: any) {\n  if (xs.some(x=>x>1&&x.kind==='a')) return\n  return {a:1,b:[2,3,],}\n}",
      "ts:src/a.ts#f",
    )

    expect(rules.map((r) => r.condition ?? r.expr)).toEqual([
      'xs.some((x) => x > 1 && x.kind === "a")',
      "{ a: 1, b: [2, 3] }",
    ])
  })

  it("keeps the comma of an array hole, which the program counts", async () => {
    const { rules } = await walkOf(
      "export function f(xs: any) {\n  if (eq(xs, [,], [a, ,], [a,])) return\n}",
      "ts:src/a.ts#f",
    )

    expect(rules.map((r) => r.condition)).toEqual(["eq(xs, [,], [a,,], [a])"])
  })

  it.each([
    ["(a - b) + c", "a - b + c"],
    ["(a.b).c((d))", "a.b.c(d)"],
    ["!(a.b) || -(1) || new (a.b)()", "!a.b || -1 || new a.b()"],
    ["(a || b) ? c : (d = e)", "a || b ? c : d = e"],
    ["[(a), ((b))].map(() => (a))", "[a, b].map(() => a)"],
    ["a - (b - c)", "a - (b - c)"],
    ["(a + b) * c", "(a + b) * c"],
    ["(a ?? b) || c", "(a ?? b) || c"],
    ["(-a) ** b + a ** (-b)", "(-a) ** b + a ** -b"],
    ["(a?.b).c", "(a?.b).c"],
    ["-(-a) || - -a || --a || +(+a) || + +a || ++a", "- -a || - -a || --a || + +a || + +a || ++a"],
    ["!(!a) || -(--a) || (a)++ || ++(a)", "!!a || - --a || a++ || ++a"],
    ["g((a) as T, (b) satisfies U, a[(b)])", "g(a as T, b satisfies U, a[b])"],
    [
      "(new A()).b || (new A).b || new (A) || new A",
      "new A().b || new A().b || new A() || new A()",
    ],
    ["(a?.b.c).d || (a?.b)() || (a?.b)!.c || (b)!", "(a?.b.c).d || (a?.b)() || (a?.b)!.c || (b)!"],
    ["new (a().b)()", "new (a().b)()"],
    [`g(class { 'm'() {} "a b"(x) {} })`, `g(class { m() {}; "a b"(x) {} })`],
    ["new (a())()", "new (a())()"],
    ["f((a, b))", "f((a, b))"],
    ["(a ? b : c) ? d : e", "(a ? b : c) ? d : e"],
    ["(1).toFixed()", "(1).toFixed()"],
    ["g(() => ({}))", "g(() => ({}))"],
    ["(a as B).c", "(a as B).c"],
    ["a && b || c && d", "(a && b) || (c && d)"],
    ["(a && b) || c", "(a && b) || c"],
    ["a + b % c - (d | e & f)", "a + (b % c) - (d | (e & f))"],
    ["a + b | c || a * b % c", "((a + b) | c) || (a * b) % c"],
    ["await a !== (await b)", "(await a) !== (await b)"],
    ["f(...a || b, ...(c), ...((d ? e : g)))", "f(...(a || b), ...c, ...(d ? e : g))"],
    ["a ? b ?? c : (d as T)", "a ? (b ?? c) : (d as T)"],
    ["a ? b satisfies T : c", "a ? (b satisfies T) : c"],
    [
      "xs.map((x) => (x ? 1 : 2), (y) => y ? 1 : 2)",
      "xs.map((x) => (x ? 1 : 2), (y) => (y ? 1 : 2))",
    ],
  ])("writes %s as %s", async (source, written) => {
    const { rules } = await walkOf(
      `export async function f(a: any) {\n  if (${source}) return\n}`,
      "ts:src/a.ts#f",
    )

    expect(rules.map((r) => r.condition)).toEqual([written])
  })

  it.each([
    ...[117, 118, 240, 241, 242].map((n) => [`a name of ${n} letters`, `g(${"a".repeat(n)},)`]),
    ...[58, 59, 120, 121].map((n) => [`a string of ${n} emoji`, `h("${"😀".repeat(n)}",)`]),
  ])("cuts a condition holding %s where its whole text would be cut", async (_label, call) => {
    const { rules } = await walkOf(
      `export function f(a: any) {\n  if (${call} || x) return\n}`,
      "ts:src/a.ts#f",
    )

    expect(rules.map((r) => r.condition)).toEqual([
      normalizeRuleText(`${call.replace(",)", ")")} || x`),
    ])
  })

  it("writes a number, a key and a template's substitution in one spelling", async () => {
    const { rules } = await walkOf(
      `export function f(a: any) {\n  if (a > 1.50 && a < .5E+01) return { 'k': a, 'max-age': 0XFF }\n  return \`\${ a+1 }\`\n}`,
      "ts:src/a.ts#f",
    )

    expect(rules.map((r) => r.condition ?? r.expr)).toEqual([
      "a > 1.5 && a < 0.5e1",
      '{ k: a, "max-age": 0xff }',
      `\`\${a + 1}\``,
    ])
  })

  it("keeps numbers of different values apart", async () => {
    const { rules } = await walkOf(
      "export function f(a: any) {\n  if (eq(1.05, 1.5, 010, 10, 10n, 1e10, 1e1, 1e0)) return\n}",
      "ts:src/a.ts#f",
    )

    expect(rules.map((r) => r.condition)).toEqual(["eq(1.05, 1.5, 010, 10, 10n, 1e10, 1e1, 1)"])
  })

  it.each([
    [String.raw`'it\'s'`, `"it's"`],
    [`'a"b'`, String.raw`"a\"b"`],
    [`'a", "b'`, String.raw`"a\", \"b"`],
    [String.raw`'\x41\u{1F600}'`, `"A😀"`],
    [String.raw`'a\u00a0b\u200b\t'`, String.raw`"a\u00a0b\u200b\t"`],
    [String.raw`'\1'`, String.raw`'\1'`],
  ])("writes the string %s as %s", async (written, recorded) => {
    const { rules } = await walkOf(
      `export function f(a: any) {\n  if (eq(a, ${written})) return\n}`,
      "ts:src/a.ts#f",
    )

    expect(rules.map((r) => r.condition)).toEqual([`eq(a, ${recorded})`])
  })

  it.each([
    [
      "an `if` and its `else`",
      "if (x) g(); else h();",
      "if (x) g()\n    else h()",
      "if (x) g() else h()",
    ],
    ["a `do … while`", "do g(); while (x);", "do g()\n    while (x)", "do g() while (x)"],
    [
      "a loop's body",
      "for (const y of ys) g(y);",
      "for (const y of ys) g(y)",
      "for (const y of ys) g(y)",
    ],
    ["a labelled statement", "l: for (;;) break l;", "l: for (;;) break l", "l: for (;;) break l"],
    [
      "a class's members",
      "return class { a = 1; b = 2; m() {}; }",
      "return class {\n      a = 1\n      b = 2\n      m() {}\n    }",
      "return class { a = 1; b = 2; m() {} }",
    ],
    [
      "a `for` head, whose semicolons are not a statement's",
      "for (let i = 0; i < n; i++) g(i);",
      "for (let i = 0; i < n; i++) g(i)",
      "for (let i = 0; i < n; i++) g(i)",
    ],
  ])(
    "writes %s the same with or without the semicolons",
    async (_label, written, bare, recorded) => {
      const conditionOf = async (body: string) => {
        const { rules } = await walkOf(
          `export function f(x: any, ys: any[], n: number) {\n  if (run(() => { ${body} })) return\n}`,
          "ts:src/a.ts#f",
        )
        return rules[0]?.condition
      }

      expect(await conditionOf(written)).toBe(`run(() => { ${recorded} })`)
      expect(await conditionOf(bare)).toBe(`run(() => { ${recorded} })`)
    },
  )

  it.each([
    ["text re-wrapped over lines", "<p>\n      a\n      b\n    </p>", "<p>a b</p>"],
    ["a line break written as CRLF", "<p>a\r\n      b</p>", "<p>a b</p>"],
    ["a character reference before a line break", "<p>a&nbsp;\n      b</p>", "<p>a&nbsp; b</p>"],
    ["a character reference inside a line", "<p>a&nbsp;b</p>", "<p>a&nbsp;b</p>"],
    [
      'the `{" "}` at a line break',
      '<p>\n      a{" "}\n      <b>b</b>\n    </p>',
      "<p>a <b>b</b></p>",
    ],
    ["a string holding more than spaces", `<p>{"a"} {'&amp;'}</p>`, '<p>{"a"} {"&amp;"}</p>'],
    ["an attribute's quotes", `<a b='x' c='y"z' d="w" />`, `<a b="x" c='y"z' d="w" />`],
  ])("writes JSX holding %s as React renders it", async (_label, jsx, recorded) => {
    const { rules } = await walkOf(
      `export function V(a: any) {\n  if (a) return null\n  return ${jsx}\n}`,
      "ts:src/a.tsx#V",
      "src/a.tsx",
    )

    expect(rules.map((r) => r.expr)).toContain(recorded)
  })

  it.each([
    ["a generic", "m: Map<string,Array<number>>", "Map<string, Array<number>>"],
    ["a function type", "cb: (a:string,b?:number)=>void", "(a: string, b?: number) => void"],
    ["a conditional type", "c: T extends string?A:B", "T extends string ? A : B"],
    ["an indexed and an array type", "x: T['k'][]", 'T["k"][]'],
    [
      "a parenthesized type",
      "x: ((A))[] | (A | B)[] | (keyof T)[]",
      "A[] | (A | B)[] | (keyof T)[]",
    ],
  ])("writes %s as it reads on one line", async (_label, param, type) => {
    const symbol = await symbolOf(`export function f<T>(${param}) {}`, "ts:src/a.ts#f")

    expect(symbol.signature?.inputs.map((i) => i.type)).toEqual([type])
  })

  it("writes a decorator's raw form and arguments as they read on one line", async () => {
    const symbol = await symbolOf(
      "@Module({\n  imports: [A, B,],\n  path: 'x',\n})\nexport class M {}",
      "ts:src/a.ts#M",
    )

    expect(symbol.decorators.map((d) => [d.raw, d.arguments])).toEqual([
      ['Module({ imports: [A, B], path: "x" })', ['{ imports: [A, B], path: "x" }']],
    ])
  })
})

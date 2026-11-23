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
  ])("%s", async (_label, file, before, after) => {
    const diff = await diffOfEdit(workspace, file, before, after)

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
      "a string that needs an escape in one spelling",
      "export function f(s: string) {\n  if (s === 'it\\'s') throw new E()\n}\n",
      'export function f(s: string) {\n  if (s === "it\'s") throw new E()\n}\n',
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
    ["-(-a)", "-(-a)"],
    ["new (a())()", "new (a())()"],
    ["f((a, b))", "f((a, b))"],
    ["(a ? b : c) ? d : e", "(a ? b : c) ? d : e"],
    ["(1).toFixed()", "(1).toFixed()"],
    ["g(() => ({}))", "g(() => ({}))"],
    ["(a as B).c", "(a as B).c"],
    ["a && b || c && d", "(a && b) || (c && d)"],
    ["(a && b) || c", "(a && b) || c"],
    ["a + b % c - (d | e & f)", "a + (b % c) - (d | (e & f))"],
    ["await a !== (await b)", "(await a) !== (await b)"],
    ["f(...a || b, ...(c), ...((d ? e : g)))", "f(...(a || b), ...c, ...(d ? e : g))"],
    ["a ? b ?? c : (d as T)", "a ? (b ?? c) : (d as T)"],
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

  it.each([
    ["a generic", "m: Map<string,Array<number>>", "Map<string, Array<number>>"],
    ["a function type", "cb: (a:string,b?:number)=>void", "(a: string, b?: number) => void"],
    ["an object type", "o: {a:string,b?:number,}", "{ a: string; b?: number }"],
    ["a union with a leading bar", "u:\n    | 'a'\n    | 'b'", '"a" | "b"'],
    ["a conditional type", "c: T extends string?A:B", "T extends string ? A : B"],
    ["an indexed and an array type", "x: T['k'][]", 'T["k"][]'],
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

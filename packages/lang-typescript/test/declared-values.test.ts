import { describe, expect, it } from "vitest"
import { walkOf } from "./fixtures/ctx"

async function valuesOf(source: string, name: string): Promise<(string | null)[]> {
  const { rules } = await walkOf(source, `ts:src/a.ts#${name}`)
  return rules.filter((r) => r.type === "value").map((r) => r.expr)
}

describe("the values a declaration holds", () => {
  it.each([
    ["an exported constant", "export const TIMEOUT_MS = 5000", "TIMEOUT_MS", ["5000"]],
    ["a constant the module keeps to itself", "const RETRIES = 3", "RETRIES", ["3"]],
    ["a module-level let", "let counter = 0", "counter", ["0"]],
    ["each declarator of a list", "export var a = 1, b = 2", "b", ["2"]],
    ["an array", 'export const ROLES = ["admin", "user"]', "ROLES", ['["admin", "user"]']],
    ["a conditional", "export const pick = ok ? a : b", "pick", ["ok ? a : b"]],
    [
      "a value behind `as const`",
      "export const ROLES = roles as const",
      "ROLES",
      ["roles as const"],
    ],
    [
      "an object's entries, nested ones included, beside a member that is a Symbol of its own",
      'export const config = { retries: 3, db: { host: "x" }, ...base, run() { return a + b } }',
      "config",
      ["retries: 3", 'host: "x"', "...base"],
    ],
    [
      "an object's entries behind `as const`, past a comment",
      "export const LIMITS = {\n  // the most we take\n  max: 10,\n} as const",
      "LIMITS",
      ["max: 10"],
    ],
    [
      "an enum's members, with and without an initializer, past a comment",
      'export enum Color {\n  Red = "red",\n  // the default\n  Blue,\n}',
      "Color",
      ['Red = "red"', "Blue"],
    ],
    ["a const enum's members", "const enum Dir { Up, Down }", "Dir", ["Up", "Down"]],
    [
      "an enum's members alone, beside a namespace merged after it",
      'export enum Color { Red = "red" }\nexport namespace Color {\n  export function parse(s: string) { return s + "x" }\n  export const X = 1\n}',
      "Color",
      ['Red = "red"'],
    ],
    [
      "an enum's members, beside a namespace merged before it",
      'export namespace Color {\n  export const X = 1\n}\nexport enum Color { Red = "red" }',
      "Color",
      ['Red = "red"'],
    ],
    [
      "a constant a namespace declares",
      "export namespace Limits {\n  export const MAX = 10\n}",
      "Limits.MAX",
      ["10"],
    ],
    [
      "an object's entries, past the members that are functions or hold a call",
      "export const o = {\n  [k]() { if (a) go(); return a + b },\n  [j]: () => a - b,\n  c: await make({ n: 3 }),\n  n: 1,\n}",
      "o",
      ["n: 1"],
    ],
    [
      "the members of every declaration of a merged enum",
      "export enum Merged { A = 1 }\nexport enum Merged { B = 2 }",
      "Merged",
      ["A = 1", "B = 2"],
    ],
  ])("reads %s", async (_label, source, name, values) => {
    expect(await valuesOf(source, name)).toEqual(values)
  })

  it.each([
    ["a call", "export const client = createClient({ retries: 3 })", "client"],
    ["a call behind `as`", "export const client = createClient() as Client", "client"],
    ["a `new`", "export const cache = new Map()", "cache"],
    ["a call a member is read off", "export const db = createClient({ retries: 3 }).db", "db"],
    ["a call beside a fallback", "export const port = readPort({ fallback: 3 }) ?? 8080", "port"],
    ["an `await`", "export const ready = await connected", "ready"],
    ["an array of functions", "export const handlers = [() => a, () => b]", "handlers"],
    ["a destructured binding", "export const { host } = config", "host"],
    ["an ambient declaration", "export declare const ambient: number", "ambient"],
  ])("reads no value for %s", async (_label, source, name) => {
    expect(await valuesOf(source, name)).toEqual([])
  })

  it("reads no value inside a function's body", async () => {
    const { rules } = await walkOf(
      "export function f() {\n  const limit = 10\n  use(limit)\n}",
      "ts:src/a.ts#f",
    )

    expect(rules).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import { walkOf } from "./fixtures/ctx"

type Binder = "nothing" | "an inner scope" | "the module"

const MARKS: Record<Binder, { unboundHead?: true; localHead?: true }> = {
  nothing: { unboundHead: true },
  "an inner scope": { localHead: true },
  "the module": {},
}

const marksOf = async (source: string, target: string, symbol: string) => {
  const calls = (await walkOf(source, symbol)).calls.filter((c) => c.target === target)
  expect(calls).toHaveLength(1)
  const [call] = calls
  return {
    ...(call?.unboundHead === undefined ? {} : { unboundHead: call.unboundHead }),
    ...(call?.localHead === undefined ? {} : { localHead: call.localHead }),
  }
}

const F = "ts:src/a.ts#f"
const row = (label: string, source: string, target: string, binder: Binder, symbol = F) =>
  [label, binder, source, target, symbol] as const
const withF = (before: readonly string[], ...body: string[]) =>
  [...before, "export function f(list: unknown[]) {", ...body, "}"].join("\n")
const inF = (...body: string[]) => withF([], ...body)

describe("a call marks which scope binds its leading name", () => {
  it.each([
    row("a global's member", inF('  console.log("a")'), "console.log", "nothing"),
    row("a global called itself", inF("  setTimeout(() => {}, 1)"), "setTimeout", "nothing"),
    row("a class constructed by a global name", inF("  new Error()"), "Error", "nothing"),
    row("a chain through a global's call", inF("  expect(list).toBe(1)"), "expect.toBe", "nothing"),
    row("a name nothing declares", inF("  describe()"), "describe", "nothing"),
    row(
      "a global behind a non-null assertion",
      inF("  process!.exit()"),
      "process!.exit",
      "nothing",
    ),
    row("a global in parentheses", inF("  (window as any).close()"), "window.close", "nothing"),
    row("CommonJS's `require` called itself", inF('  require("./util")'), "require", "nothing"),

    row("a parameter", inF("  list.map(String)"), "list.map", "an inner scope"),
    row(
      "a local arrow named after an import",
      withF(['import { save } from "./save"'], "  const save = () => 1", "  save()"),
      "save",
      "an inner scope",
    ),
    row(
      "a nested function named after one of the module",
      withF(["function remove() {}"], "  function remove() {}", "  remove()"),
      "remove",
      "an inner scope",
    ),
    row(
      "a block's `const`",
      inF("  { const console = make(); console.log() }"),
      "console.log",
      "an inner scope",
    ),
    row(
      "a callback's parameter",
      inF("  list.forEach((item) => item.run())"),
      "item.run",
      "an inner scope",
    ),
    row(
      "a `catch` binding",
      inF("  try {} catch (handler) { handler() }"),
      "handler",
      "an inner scope",
    ),
    row(
      "a `for…of` binding",
      inF("  for (const job of list) job.run()"),
      "job.run",
      "an inner scope",
    ),
    row(
      "a `var` the function declares later",
      inF("  later.run()", "  var later = make()"),
      "later.run",
      "an inner scope",
    ),
    row("a local class", inF("  class Local {}", "  Local.make()"), "Local.make", "an inner scope"),
    row(
      "a function expression's own name, under another name",
      inF("  const g = function again() { again() }"),
      "again",
      "an inner scope",
    ),

    row(
      "an import",
      withF(['import { log } from "./log"'], "  log.write()"),
      "log.write",
      "the module",
    ),
    row(
      "a declaration of the module",
      withF(["function log() {}"], "  log()"),
      "log",
      "the module",
    ),
    row(
      "a function the module declares after it",
      [inF("  later()"), "function later() {}"].join("\n"),
      "later",
      "the module",
    ),
    row(
      "a class of the module",
      withF(["class Repo {}"], "  Repo.make()"),
      "Repo.make",
      "the module",
    ),
    row(
      "an enum of the module",
      withF(["enum Kind { A }"], "  Kind.parse()"),
      "Kind.parse",
      "the module",
    ),
    row(
      "a namespace of the module",
      withF(["namespace ns { export function g() {} }"], "  ns.g()"),
      "ns.g",
      "the module",
    ),
    row(
      "a type-only import",
      withF(['import type { Repo } from "./repo"'], "  Repo.make()"),
      "Repo.make",
      "the module",
    ),
    row(
      "a declared global",
      withF(["declare const env: Env"], "  env.read()"),
      "env.read",
      "the module",
    ),
    row(
      "a global the module declares",
      withF(["declare global { const env: Env }"], "  env.read()"),
      "env.read",
      "the module",
    ),
    row(
      "a global `var` the module declares",
      withF(["declare global { var app: App }"], "  app.run()"),
      "app.run",
      "the module",
    ),
    row("CommonJS's `exports`", inF("  exports.run()"), "exports.run", "the module"),
    row("CommonJS's `module`", inF("  module.exports.run()"), "module.exports.run", "the module"),
    row(
      "a module `require` gives back",
      inF('  require("./util").helper()'),
      "require.helper",
      "the module",
    ),
    row(
      "a class declaration's own name in its body",
      "export class Repo {\n  static make() {}\n  f() { Repo.make() }\n}",
      "Repo.make",
      "the module",
      "ts:src/a.ts#Repo.f",
    ),
    row(
      "a function expression's own name, where it is the module's `const` of that name",
      "export const g = function g() { g() }",
      "g",
      "the module",
      "ts:src/a.ts#g",
    ),
    row(
      "a namespace's function in the namespace",
      "namespace NS {\n  export function helper() {}\n  export function f() { return helper() }\n}",
      "helper",
      "the module",
      "ts:src/a.ts#NS.f",
    ),
    row(
      "a namespace's class in its own body",
      "namespace NS {\n  export class Repo {\n    static make() {}\n    g() { Repo.make() }\n  }\n}",
      "Repo.make",
      "the module",
      "ts:src/a.ts#NS.Repo.g",
    ),
  ])("reads %s as bound by %s", async (_label, binder, source, target, symbol) => {
    expect(await marksOf(source, target, symbol)).toEqual(MARKS[binder])
  })

  it("marks neither on a call through `this`", async () => {
    const source = "export class C {\n  f() { this.run() }\n}"
    expect(await marksOf(source, "this.run", "ts:src/a.ts#C.f")).toEqual({})
  })
})

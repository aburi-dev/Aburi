import { describe, expect, it } from "vitest"
import { walkOf } from "./fixtures/ctx"

const localOf = async (source: string, target: string, symbol = "ts:src/a.ts#f") => {
  const calls = (await walkOf(source, symbol)).calls.filter((c) => c.target === target)
  expect(calls).toHaveLength(1)
  return calls[0]?.localHead
}

const withF = (before: readonly string[], ...body: string[]) =>
  [...before, "export function f(list: unknown[]) {", ...body, "}"].join("\n")
const inF = (...body: string[]) => withF([], ...body)

describe("a call marks a leading name a scope inside the module declares", () => {
  it.each([
    ["a parameter", inF("  list.map(String)"), "list.map"],
    [
      "a local arrow named after an import",
      withF(['import { save } from "./save"'], "  const save = () => 1", "  save()"),
      "save",
    ],
    [
      "a nested function named after one of the module",
      withF(["function remove() {}"], "  function remove() {}", "  remove()"),
      "remove",
    ],
    ["a block's `const`", inF("  { const console = make(); console.log() }"), "console.log"],
    ["a callback's parameter", inF("  list.forEach((item) => item.run())"), "item.run"],
    ["a `catch` binding", inF("  try {} catch (handler) { handler() }"), "handler"],
    ["a `for…of` binding", inF("  for (const job of list) job.run()"), "job.run"],
    [
      "a `var` the function declares later",
      inF("  later.run()", "  var later = make()"),
      "later.run",
    ],
    ["a local class", inF("  class Local {}", "  Local.make()"), "Local.make"],
    ["a function expression's own name", inF("  const g = function again() { again() }"), "again"],
  ])("marks %s", async (_label, source, target) => {
    expect(await localOf(source, target)).toBe(true)
  })

  it.each([
    ["an import", withF(['import { log } from "./log"'], "  log.write()"), "log.write"],
    ["a declaration of the module", withF(["function log() {}"], "  log()"), "log"],
    ["a class of the module", withF(["class Repo {}"], "  Repo.make()"), "Repo.make"],
    ["a global", inF('  console.log("a")'), "console.log"],
    ["a declared global", withF(["declare const env: Env"], "  env.read()"), "env.read"],
  ])("leaves it unmarked where %s binds the name", async (_label, source, target) => {
    expect(await localOf(source, target)).toBeUndefined()
  })

  it("leaves unmarked a class declaration's own name in its body", async () => {
    const source = "export class Repo {\n  static make() {}\n  f() { Repo.make() }\n}"
    expect(await localOf(source, "Repo.make", "ts:src/a.ts#Repo.f")).toBeUndefined()
  })

  it("leaves a call through `this` unmarked", async () => {
    const source = "export class C {\n  f() { this.run() }\n}"
    expect(await localOf(source, "this.run", "ts:src/a.ts#C.f")).toBeUndefined()
  })
})

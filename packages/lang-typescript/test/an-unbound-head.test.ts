import { describe, expect, it } from "vitest"
import { walkOf } from "./fixtures/ctx"

const unboundOf = async (source: string, target: string, symbol = "ts:src/a.ts#f") => {
  const calls = (await walkOf(source, symbol)).calls.filter((c) => c.target === target)
  expect(calls).toHaveLength(1)
  return calls[0]?.unboundHead
}

const withF = (before: readonly string[], ...body: string[]) =>
  [...before, "export function f(list: unknown[]) {", ...body, "}"].join("\n")
const inF = (...body: string[]) => withF([], ...body)

describe("a call marks a leading name no scope around it declares", () => {
  it.each([
    ["a global's member", inF('  console.log("a")'), "console.log"],
    ["a global called itself", inF("  setTimeout(() => {}, 1)"), "setTimeout"],
    ["a class constructed by a global name", inF("  new Error()"), "Error"],
    ["a chain through a global's call", inF("  expect(list).toBe(1)"), "expect.toBe"],
    ["a name nothing declares", inF("  describe()"), "describe"],
    ["a global behind a non-null assertion", inF("  process!.exit()"), "process!.exit"],
    ["a global in parentheses", inF("  (window as any).close()"), "window.close"],
  ])("marks %s", async (_label, source, target) => {
    expect(await unboundOf(source, target)).toBe(true)
  })

  it.each([
    ["an import", withF(['import { log } from "./log"'], "  log.write()"), "log.write"],
    ["a declaration of the module", withF(["function log() {}"], "  log()"), "log"],
    ["a parameter", inF("  list.map(String)"), "list.map"],
    ["a block's `const`", inF("  { const console = make(); console.log() }"), "console.log"],
    ["a callback's parameter", inF("  list.forEach((item) => item.run())"), "item.run"],
    [
      "a `var` the function declares later",
      inF("  later.run()", "  var later = make()"),
      "later.run",
    ],
    ["a declared global", withF(["declare const env: Env"], "  env.read()"), "env.read"],
  ])("leaves it unmarked where %s binds the name", async (_label, source, target) => {
    expect(await unboundOf(source, target)).toBeUndefined()
  })

  it("leaves a call through `this` unmarked", async () => {
    const source = "export class C {\n  f() { this.run() }\n}"
    expect(await unboundOf(source, "this.run", "ts:src/a.ts#C.f")).toBeUndefined()
  })
})

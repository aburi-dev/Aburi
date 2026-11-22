import { describe, expect, it } from "vitest"
import { symbolOf } from "./fixtures/ctx"

const MANAGER = "ts:src/a.ts#manager"

describe("a variable names the type its value is declared with", () => {
  it.each([
    [
      "a `const` constructed from a class",
      "export const manager = new Manager()",
      MANAGER,
      "Manager",
    ],
    [
      "a `const` constructed from a namespace's generic class",
      'import * as ns from "./manager"\nexport const manager = new ns.Manager<Payload>()',
      MANAGER,
      "ns.Manager",
    ],
    ["a `const` the module keeps to itself", "const manager = new Manager()", MANAGER, "Manager"],
    [
      "an annotated `let` that may be `null`",
      "export let manager: Manager | null = null",
      MANAGER,
      "Manager",
    ],
    ["an ambient `const`", "export declare const manager: Manager", MANAGER, "Manager"],
    [
      "a namespace's `const` constructed from a class the module declares",
      "class Manager {}\nexport namespace N {\n  export const manager = new Manager()\n}",
      "ts:src/a.ts#N.manager",
      "Manager",
    ],
  ])("as the module binds it, for %s", async (_label, source, id, type) => {
    expect((await symbolOf(source, id)).valueType).toBe(type)
  })

  it.each([
    [
      "a `let` constructed from a class, which can be assigned another",
      "export let manager = new Manager()",
    ],
    ["a `const` holding a call's result", "export const manager = make()"],
    ["a union of two types", "export const manager: Manager | Other = make()"],
    [
      "a class the namespace declares",
      "export namespace N {\n  class Manager {}\n  export const manager = new Manager()\n}",
    ],
  ])("is absent for %s", async (_label, source) => {
    const id = source.includes("namespace") ? "ts:src/a.ts#N.manager" : MANAGER
    expect(await symbolOf(source, id)).not.toHaveProperty("valueType")
  })
})

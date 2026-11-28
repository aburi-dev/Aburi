import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { idsOf, symbolOf, symbolsOf } from "./fixtures/ctx"
import { changedSymbols, diffOfEdit } from "./fixtures/scan"

const id = (qname: string) => `ts:src/a.ts#${qname}`

describe("the value `export =` makes the module", () => {
  it.each([
    [
      "a function expression, under its own name",
      "export = function handler(req: Req) {\n  return db.users.find(req.id)\n}\n",
      ["handler"],
    ],
    [
      "a class expression, under its own name, with its members",
      "export = class UserService {\n  find(id: string) {\n    return lookup(id)\n  }\n  static of() {}\n}\n",
      ["UserService", "UserService.find", "UserService::of"],
    ],
    ["an arrow function, as `<default>`", "export = (x: number) => x + 1\n", ["<default>"]],
    [
      "an anonymous class, as `<default>` holding its members' calls",
      "export = class {\n  find() {\n    return lookup()\n  }\n}\n",
      ["<default>"],
    ],
    [
      "a named function behind wrappers, under its own name",
      "export = ((function handler() {\n  go()\n}) as Handler)!\n",
      ["handler"],
    ],
    [
      "a named class behind a wrapper, under its own name, with its members",
      "export = (class C {\n  m() {\n    go()\n  }\n}) satisfies Ctor\n",
      ["C", "C.m"],
    ],
    [
      "a call handed a function, as `<default>`",
      "export = withAuth(() => {\n  go()\n})\n",
      ["<default>"],
    ],
    [
      "a declaration the statement names",
      "function handler() {\n  go()\n}\nexport = handler\n",
      ["handler"],
    ],
    [
      "a declaration the statement names behind a wrapper",
      "const handler = () => go()\nexport = handler as Handler\n",
      ["handler"],
    ],
  ])("is %s, exported", async (_label, source, qnames) => {
    const symbols = await symbolsOf(source)

    expect(symbols.map((s) => s.id)).toEqual(qnames.map(id))
    const [value] = symbols
    expect(value?.visibility).toBe("public")
    expect(value?.derivedBy).toContain("export-assignment")
  })

  it("reads the JSDoc written above the statement", async () => {
    const source = "/** @throws {Gone} */\nexport = function handler() {}\n"

    expect((await symbolOf(source, id("handler"))).signature?.throws).toEqual(["Gone"])
  })

  it.each([
    ["an import", 'import handler = require("./h")\nexport = handler\n'],
    ["a value it does not hold by name", "export = { find() {} }\n"],
  ])("declares nothing for %s", async (_label, source) => {
    expect(await idsOf(source)).toEqual([])
  })

  it("leaves `export import` an alias the module exports, with no export assignment", async () => {
    const source = "export namespace N {\n  export function b() {}\n}\nexport import A = N.b\n"

    expect(
      (await symbolsOf(source)).filter((s) => s.derivedBy.includes("export-assignment")),
    ).toEqual([])
  })
})

describe("a diff of a module `export =` makes a value", () => {
  const workspace = useScratchWorkspace("export-assignment")
  const FILE = "src/a.ts"

  it.each([
    [
      "a function's body",
      "export = function handler(req: Req) {\n  return db.users.find(req.id)\n}\n",
      "export = function handler(req: Req) {\n  return db.users.deleteMany()\n}\n",
      ["handler"],
    ],
    [
      "a class method's body",
      "export = class UserService {\n  find(id: string) {\n    return lookup(id)\n  }\n}\n",
      "export = class UserService {\n  find(id: string) {\n    return destroy(id)\n  }\n}\n",
      ["UserService", "UserService.find"],
    ],
  ])("reports an edit to %s", async (_label, before, after, names) => {
    const diff = await diffOfEdit(workspace, FILE, before, after)

    expect(changedSymbols(diff).map((c) => c.name)).toEqual(names)
  })

  it("reports an export assignment made a default export as an export name changed", async () => {
    const diff = await diffOfEdit(
      workspace,
      FILE,
      "function handler() {\n  go()\n}\nexport = handler\n",
      "function handler() {\n  go()\n}\nexport default handler\n",
    )

    expect(changedSymbols(diff)).toMatchObject([
      {
        name: "handler",
        apiChanged: true,
        logicChanged: false,
        exportedAs: { added: ["default"], removed: ["export="], modified: [] },
      },
    ])
  })
})

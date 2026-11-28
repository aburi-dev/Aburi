import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { idsOf, importsOf, symbolOf, symbolsOf, walksOf } from "./fixtures/ctx"
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

  interface Assigned {
    readonly kind: string
    readonly calls: readonly string[]
    readonly derivedBy?: readonly string[]
  }

  it.each<[string, string, Assigned, string[]]>([
    [
      "an anonymous class, holding its members' calls",
      "export = class {\n  find() {\n    return lookup()\n  }\n}\n",
      { kind: "class", calls: ["lookup"] },
      [],
    ],
    [
      "a call handed a function, the `const` holding the call and the function's calls",
      "export = withAuth(() => {\n  go()\n})\n",
      { kind: "const", calls: ["withAuth", "go"], derivedBy: ["call-argument-function"] },
      [],
    ],
    [
      "an object literal, the `const` holding the calls of the functions it holds",
      "export = {\n  find() {\n    return lookup()\n  },\n  run: go,\n}\n",
      { kind: "const", calls: ["lookup"] },
      [],
    ],
    ["a member access, a `const`", "export = Routes.handler\n", { kind: "const", calls: [] }, []],
    [
      "a function expression whose name the module declares otherwise",
      "function handler() {\n  go()\n}\nexport = function handler() {\n  run()\n}\n",
      { kind: "function", calls: ["run"] },
      ["handler"],
    ],
    [
      "a class expression whose name the module declares otherwise, holding its members' calls",
      "class Svc {}\nexport = class Svc {\n  find() {\n    return lookup()\n  }\n}\n",
      { kind: "class", calls: ["lookup"] },
      ["Svc"],
    ],
    [
      "a function expression whose name an import binds",
      'import handler = require("./h")\nexport = function handler() {\n  run()\n}\n',
      { kind: "function", calls: ["run"] },
      [],
    ],
  ])("is `<default>` for %s", async (_label, source, value, internal) => {
    const symbols = await symbolsOf(source)
    const walks = await walksOf(source)
    const assigned = symbols.find((s) => s.id === id("<default>"))

    expect(symbols.map((s) => s.id).sort()).toEqual([id("<default>"), ...internal.map(id)].sort())
    expect(assigned).toMatchObject({ kind: value.kind, visibility: "public" })
    expect(assigned?.derivedBy).toEqual(
      expect.arrayContaining(["export-assignment", ...(value.derivedBy ?? [])]),
    )
    expect(walks.get(id("<default>"))?.calls.map((call) => call.target)).toEqual(value.calls)
    for (const name of internal) {
      expect(symbols.find((s) => s.id === id(name))?.visibility).toBe("internal")
    }
  })

  it("reads the JSDoc written above the statement", async () => {
    const source = "/** @throws {Gone} */\nexport = function handler() {}\n"

    expect((await symbolOf(source, id("handler"))).signature?.throws).toEqual(["Gone"])
  })

  it.each([
    ["bound whole", 'import h = require("./h")\nexport = h\n', "*"],
    ["by name, behind a wrapper", 'import { a as h } from "./h"\nexport = (h)!\n', "a"],
    ["as its default", 'import h from "./h"\nexport = h\n', "default"],
  ])(
    "declares nothing for an import, which its edge re-exports %s",
    async (_label, source, imported) => {
      expect(await idsOf(source)).toEqual([])
      expect((await importsOf(source)).imports.map((edge) => edge.reexports)).toEqual([
        [{ imported, exported: "export=" }],
      ])
    },
  )

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

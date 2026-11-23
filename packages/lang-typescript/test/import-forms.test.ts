import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { importsOf } from "./fixtures/ctx"

describe("import-equals-require binds the module object", () => {
  it.each([
    ["the plain form", "import x = require('./mod')", "src/a.ts"],
    ["a type-only form", "import type x = require('./mod')", "src/a.ts"],
    [
      "the CommonJS extension it is the ordinary form for",
      "import x = require('./mod')",
      "src/a.cts",
    ],
  ])(
    "as a static namespace edge carrying the local binding, in %s",
    async (_label, source, path) => {
      const { imports, errors } = await importsOf(source, path)

      expect(imports).toEqual([
        { source: "./mod", symbols: "*", line: 1, dynamic: false, namespaceBinding: "x" },
      ])
      expect(errors).toEqual([])
    },
  )

  it("says nothing about an alias that renames a local namespace", async () => {
    const { imports, errors } = await importsOf("import x = A.B.C")

    expect(imports).toEqual([])
    expect(errors).toEqual([])
  })

  it.each([
    ["a concatenation whose first operand is a literal", `import x = require("a" + b)`],
    ["a concatenation whose second operand is a literal", `import x = require(b + "./real")`],
    ["a second argument", "import x = require('./m', 'y')"],
    ["a nested call", "import x = require(f('./m'))"],
  ])("refuses a clause that did not parse — %s", async (_label, source) => {
    const { imports, errors } = await importsOf(source)

    expect(imports).toEqual([])
    expect(errors.some((e) => e.message === "syntax error")).toBe(true)
  })

  it("keeps a require-equals beside an ordinary import, in source order", async () => {
    const { imports } = await importsOf("import { A } from './a'\nimport b = require('./b')")

    expect(imports).toEqual([
      { source: "./a", symbols: ["A"], line: 1, dynamic: false },
      { source: "./b", symbols: "*", line: 2, dynamic: false, namespaceBinding: "b" },
    ])
  })
})

describe("the specifier of import()", () => {
  it.each([
    ["past a webpack magic comment", 'const m = import(/* webpackChunkName: "x" */ "./mod")'],
    ["past two comments", "const m = import(/* a */ /* b */ './mod')"],
    ["in a template with nothing substituted into it", "const m = import(`./mod`)"],
  ])("is read %s", async (_label, source) => {
    const { imports, errors } = await importsOf(source)

    expect(imports).toEqual([{ source: "./mod", symbols: "*", line: 1, dynamic: true }])
    expect(errors).toEqual([])
  })

  it.each([
    ["a comment that is all there is", "const m = import(/* nothing here */)"],
    ["a variable", "const m = import(p)"],
    ["a concatenation", 'const m = import("" + x)'],
    ["a trailing substitution", `const m = import(\`./\${p}\`)`],
    ["a substitution in the middle", `const m = import(\`./a\${p}/b\`)`],
    ["a leading substitution", `const m = import(\`\${dir}/b\`)`],
    ["nothing but a substitution", `const m = import(\`\${p}\`)`],
  ])("gives no edge and no diagnostic for %s", async (_label, source) => {
    const { imports, errors } = await importsOf(source)

    expect(imports).toEqual([])
    expect(errors).toEqual([])
  })
})

describe("a CommonJS require()", () => {
  const m = { source: "./m", line: 1, dynamic: false }

  it.each<[string, string, ImportEdge]>([
    ["a module object", 'const m = require("./m")', { ...m, symbols: "*", namespaceBinding: "m" }],
    ["a `var`", "var m = require('./m')", { ...m, symbols: "*", namespaceBinding: "m" }],
    ["a backtick", "let m = require(`./m`)", { ...m, symbols: "*", namespaceBinding: "m" }],
    [
      "a comment",
      'const m = require(/* c */ "./m")',
      { ...m, symbols: "*", namespaceBinding: "m" },
    ],
    [
      "a destructuring, renamed and defaulted entries included",
      'const { a, b: c, d = 1, e: f = 2, "g": h } = require("./m")',
      { ...m, symbols: ["a", "b as c", "d", "e as f", "g as h"] },
    ],
    [
      "a property read off it",
      'const Router = require("./m").Router',
      { ...m, symbols: ["Router"] },
    ],
    [
      "a property renamed",
      'const Client = require("./m")["Pool"]',
      { ...m, symbols: ["Pool as Client"] },
    ],
    [
      "its default export",
      'const app = require("./m").default',
      { ...m, symbols: ["default as app"] },
    ],
    ["a rest pattern alone", 'const { ...rest } = require("./m")', { ...m, symbols: "*" }],
    ["an array pattern", 'const [first] = require("./m")', { ...m, symbols: "*" }],
    ["a destructured property", 'const { a } = require("./m").nested', { ...m, symbols: "*" }],
    ["a statement of its own", 'require("./m")', { ...m, symbols: "*" }],
    ["a call of what it gives back", 'const app = require("./m")()', { ...m, symbols: "*" }],
  ])("at the top level, binds what an import would: %s", async (_label, source, edge) => {
    const { imports, errors } = await importsOf(source, "src/a.js")

    expect(imports).toEqual([edge])
    expect(errors).toEqual([])
  })

  it.each([
    ["in a function", "function load() {\n  const { PrismaClient } = require('@prisma/client')\n}"],
    ["in a callback", "jest.mock('./a', () =>\n  require('@prisma/client'))"],
    ["inside a `module.exports`", "module.exports = {\n  db: require('@prisma/client'),\n}"],
  ])("anywhere else, as an import that binds nothing: %s", async (_label, source) => {
    const { imports, errors } = await importsOf(source, "src/a.js")

    expect(imports).toEqual([{ source: "@prisma/client", symbols: "*", line: 2, dynamic: false }])
    expect(errors).toEqual([])
  })

  it("gives each declarator of a declaration its own edge, at the declaration's line", async () => {
    const { imports } = await importsOf(
      'const a = require("./a"),\n  { b } = require("./b"),\n  n = 1',
      "src/a.js",
    )

    expect(imports).toEqual([
      { source: "./a", symbols: "*", line: 1, dynamic: false, namespaceBinding: "a" },
      { source: "./b", symbols: ["b"], line: 1, dynamic: false },
    ])
  })

  it("republishes what an export clause exports, as it would an import's", async () => {
    const { imports } = await importsOf('const { a } = require("./a")\nexport { a as b }')

    expect(imports).toEqual([
      {
        source: "./a",
        symbols: ["a"],
        line: 1,
        dynamic: false,
        reexports: [{ imported: "a", exported: "b" }],
      },
    ])
  })

  it.each([
    ["a variable", "const m = require(name)"],
    ["a concatenation", 'const m = require("./" + name)'],
    ["a substitution", `const m = require(\`./\${name}\`)`],
    ["a second argument", 'const m = require("./m", "x")'],
    ["no argument", "const m = require()"],
    ["a member of something else", 'const m = module.require("./m")'],
    ["`require.resolve`", 'const p = require.resolve("./m")'],
  ])("gives no edge and no diagnostic for %s", async (_label, source) => {
    const { imports, errors } = await importsOf(source, "src/a.js")

    expect(imports).toEqual([])
    expect(errors).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import { importsOf, parseErrorsOf } from "./fixtures/ctx"

describe("TypeScript 5.0's `export type *`", () => {
  it.each([
    ["from a module", "export type * from './m'\n"],
    ["as a namespace", "export type * as ns from './m'\n"],
    ["with a trailing semicolon", "export type * from './m';\n"],
    ["beside a value export", "export type * from './m'\nexport const x = 1\n"],
  ])("parses clean %s", async (_label, source) => {
    expect(await parseErrorsOf(source)).toEqual([])
    expect(await parseErrorsOf(source, "src/a.tsx")).toEqual([])
  })

  it("exports no value: its edge re-exports nothing a call can name", async () => {
    const { imports } = await importsOf(
      "export type * from './m'\nexport type * as ns from './n'\n",
    )
    expect(imports).toEqual([
      { source: "./m", symbols: "*", line: 1, dynamic: false },
      { source: "./n", symbols: "*", line: 2, dynamic: false },
    ])
  })

  it.each([
    ["with no module", "export type *\n"],
    ["with two stars", "export type ** from './m'\n"],
    ["with `type` written twice", "export type type * from './m'\n"],
  ])("still reports one %s", async (_label, source) => {
    expect(await parseErrorsOf(source)).not.toEqual([])
  })
})

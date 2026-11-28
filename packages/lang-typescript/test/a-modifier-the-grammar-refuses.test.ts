import { describe, expect, it } from "vitest"
import { idsOf, normalizedOf, parseErrorsOf, symbolOf } from "./fixtures/ctx"

const JOB = (modifier: string) =>
  `export default ${modifier}class {\n  abstract run(): void\n  start() {\n    this.run()\n  }\n}\n`

const TABLE = (signature: string) =>
  `export class Table {\n  ${signature}\n  static size() {\n    return count()\n  }\n}\n`

describe("an anonymous default-exported abstract class", () => {
  it("parses clean and is the default export, as without `abstract`", async () => {
    expect(await parseErrorsOf(JOB("abstract "))).toEqual([])
    expect(await idsOf(JOB("abstract "))).toEqual(await idsOf(JOB("")))
    expect(await symbolOf(JOB("abstract "), "ts:src/a.ts#<default>")).toMatchObject({
      kind: "class",
      visibility: "public",
    })
  })

  it("parses clean with a heritage clause and in a .tsx file", async () => {
    const source = "export default abstract class extends Base<T> {\n  run() {}\n}\n"

    expect(await parseErrorsOf(source)).toEqual([])
    expect(await parseErrorsOf(source, "src/a.tsx")).toEqual([])
  })

  it.each([
    ["before it", "export default /* c */ abstract class {\n  run() {}\n}\n"],
    ["after it", "export default abstract /* c */ class {\n  run() {}\n}\n"],
  ])("parses clean with a comment %s", async (_label, source) => {
    expect(await parseErrorsOf(source)).toEqual([])
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#<default>"])
  })

  it.each([
    ["a line break", "export default abstract\nclass {\n  run() {}\n}\n"],
    ["a comment holding a line break", "export default abstract /*\n*/ class {\n  run() {}\n}\n"],
  ])(
    "still reports `abstract` before %s, after which TypeScript reads no modifier",
    async (_label, source) => {
      expect(await parseErrorsOf(source)).not.toEqual([])
    },
  )

  it("keeps `abstract` in the normalized string, after the class's own", async () => {
    const id = "ts:src/a.ts#<default>"

    expect(await normalizedOf(JOB("abstract "), id)).toEqual(
      `${await normalizedOf(JOB(""), id)} "abstract"`,
    )
  })
})

describe("a static index signature", () => {
  it.each([
    ["a static one", "static [key: string]: number"],
    ["a static readonly one", "static readonly [key: string]: number"],
    ["one with a comment after `static`", "static /* c */ [key: string]: number"],
    ["one with comments in its brackets", "static // c\n  [ /* k */ key /* : */ : string]: number"],
    ["one over lines", "static\n  readonly /* r */ [key: string]: number"],
  ])("parses %s clean and keeps the class's members", async (_label, signature) => {
    expect(await parseErrorsOf(TABLE(signature))).toEqual([])
    expect(await idsOf(TABLE(signature))).toEqual(["ts:src/a.ts#Table", "ts:src/a.ts#Table::size"])
  })

  it("reads like an instance one, with `static` before it", async () => {
    const id = "ts:src/a.ts#Table"
    const asStatic = await normalizedOf(TABLE("static [key: string]: number"), id)
    const asInstance = await normalizedOf(TABLE("[key: string]: number"), id)

    expect(asStatic).not.toContain("ERROR")
    expect(asStatic).toEqual(asInstance.replace("(index_signature ", '(index_signature "static" '))
  })

  it("keeps the error and the tree of a `static` TypeScript refuses too, beside one it takes", async () => {
    const source = `export interface Row {\n  static [key: string]: number\n}\n${TABLE("static [key: string]: number")}`

    expect((await parseErrorsOf(source)).map((error) => error.split(":")[0])).toEqual(["2"])
    expect(await normalizedOf(source, "ts:src/a.ts#Table")).toContain('(index_signature "static"')
    expect(await normalizedOf(source, "ts:src/a.ts#Row")).not.toContain("index_signature")
  })

  it("leaves a static computed member as it parsed", async () => {
    const source = TABLE("static [Symbol.iterator]() {\n    return gen()\n  }")

    expect(await parseErrorsOf(source)).toEqual([])
    expect(await normalizedOf(source, "ts:src/a.ts#Table")).toContain('(method_definition "static"')
  })
})

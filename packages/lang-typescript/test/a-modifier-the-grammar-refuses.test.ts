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

  it("keeps `abstract` in the normalized string", async () => {
    const id = "ts:src/a.ts#<default>"

    expect(await normalizedOf(JOB("abstract "), id)).not.toEqual(await normalizedOf(JOB(""), id))
  })

  it("leaves the text alone where it is not a class head", async () => {
    const source =
      'export const s = "export default abstract class"\nexport default abstract class {'

    expect(await parseErrorsOf(source)).not.toEqual([])
    expect(await idsOf(source)).toContain("ts:src/a.ts#s")
  })
})

describe("a static index signature", () => {
  it.each([
    ["a static one", "static [key: string]: number"],
    ["a static readonly one", "static readonly [key: string]: number"],
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

  it("leaves a static computed member as it parsed", async () => {
    const source = TABLE("static [Symbol.iterator]() {\n    return gen()\n  }")

    expect(await parseErrorsOf(source)).toEqual([])
    expect(await normalizedOf(source, "ts:src/a.ts#Table")).toContain('(method_definition "static"')
  })
})

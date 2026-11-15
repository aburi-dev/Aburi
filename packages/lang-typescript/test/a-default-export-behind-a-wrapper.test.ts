import { describe, expect, it } from "vitest"
import { callsOf, idsOf, normalizedOf, symbolOf } from "./fixtures/ctx"

const DEFAULT = "ts:src/a.ts#<default>"

describe("a default export whose function is written behind a wrapper", () => {
  it.each([
    ["in parentheses", "export default (() => { q() })"],
    ["a function expression in parentheses", "export default (async function () { q() })"],
    ["behind `satisfies`", "export default (async () => { q() }) satisfies Handler"],
    ["behind `as`", "export default (() => { q() }) as Handler"],
    ["behind `!`", "export default (() => { q() })!"],
    ["in nested parentheses past a comment", "export default ((/* c */ () => { q() }))"],
    ["a generator in parentheses", "export default (function* () { yield q() })"],
    ["a named function expression", "export default (function Handler() { q() })"],
  ])("is the anonymous default function %s", async (_label, source) => {
    const symbol = await symbolOf(source, DEFAULT)

    expect(await idsOf(source)).toEqual([DEFAULT])
    expect([symbol.kind, symbol.visibility, symbol.derivedBy]).toEqual([
      "function",
      "public",
      ["export-default"],
    ])
    expect(await callsOf(source, DEFAULT)).toEqual(["q"])
  })

  it("reports what the bare spelling reports", async () => {
    const jsDoc = "/** @throws {NotFound} */\n"
    const bare = await symbolOf(`${jsDoc}export default async (id: string) => { q(id) }`, DEFAULT)
    const wrapped = await symbolOf(
      `${jsDoc}export default (async (id: string) => { q(id) }) satisfies Handler`,
      DEFAULT,
    )

    expect(wrapped.signature).toEqual(bare.signature)
    expect(wrapped.signature?.throws).toEqual(["NotFound"])
    expect(
      await normalizedOf("export default (async (id: string) => { q(id) }) satisfies H", DEFAULT),
    ).toBe(await normalizedOf("export default async (id: string) => { q(id) }", DEFAULT))
  })

  it("moves its normalized string with an edit to the function", async () => {
    expect(await normalizedOf("export default (() => { q() })", DEFAULT)).not.toBe(
      await normalizedOf("export default (() => { r() })", DEFAULT),
    )
  })

  it.each([
    ["an anonymous class", "export default (class { m() { q() } })"],
    ["a named class expression", "export default (class Foo { m() { q() } })"],
  ])(
    "is the anonymous default class, holding its members' calls, for %s",
    async (_label, source) => {
      const symbol = await symbolOf(source, DEFAULT)

      expect(await idsOf(source)).toEqual([DEFAULT])
      expect([symbol.kind, symbol.visibility, symbol.derivedBy]).toEqual([
        "class",
        "public",
        ["export-default"],
      ])
      expect(await callsOf(source, DEFAULT)).toEqual(["q"])
    },
  )

  it.each([
    ["a call in parentheses", "export default (withAuth(() => { q() }))"],
    ["a function invoked in place", "export default (async () => { await q() })()"],
  ])("leaves %s a default `const` that holds the call's body", async (_label, source) => {
    const symbol = await symbolOf(source, DEFAULT)

    expect(symbol.kind).toBe("const")
    expect(symbol.derivedBy).toContain("export-default")
    expect(await callsOf(source, DEFAULT)).toContain("q")
  })
})

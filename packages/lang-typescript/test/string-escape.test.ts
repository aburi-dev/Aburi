import { decodeStringLiteral, decodeStringLiteralOrRaw } from "@aburi/core"
import { describe, expect, it } from "vitest"
import { BACKSLASH, parseSource, requireTree } from "./fixtures/ctx"

/** The string node an import of `written` parses its specifier into. */
async function specifierNode(written: string) {
  const source = `import x from ${written}`
  const [node] = requireTree((await parseSource(source)).tree).rootNode.descendantsOfType("string")
  if (node === undefined || node === null) throw new Error(`no string node in ${source}`)
  return node
}

describe("what a literal decodes to, and whether that is all of it", () => {
  const literalOf = async (written: string) => decodeStringLiteral(await specifierNode(written))

  it.each([
    ["a plain literal", '"./m"', "./m", true],
    ["an escape", `"./a${BACKSLASH}tb"`, "./a\tb", true],
    ["an empty literal", '""', "", true],
    ["a literal that is only a line continuation", `"${BACKSLASH}\n"`, "", true],
    ["a literal that is entirely an ERROR", `"${BACKSLASH}uZZZZ"`, "", false],
    ["a literal with an ERROR after a fragment", `"a${BACKSLASH}uZZZZb"`, "a", false],
  ])("reads %s", async (_label, written, value, whole) => {
    expect(await literalOf(written)).toEqual({ value, whole })
  })

  it("tells an empty read from an unread literal, which the value alone cannot", async () => {
    const continuation = await literalOf(`"${BACKSLASH}\n"`)
    const unparsed = await literalOf(`"${BACKSLASH}uZZZZ"`)

    expect([continuation.value, unparsed.value]).toEqual(["", ""])
    expect([continuation.whole, unparsed.whole]).toEqual([true, false])
  })
})

describe("what a literal reads as when the fallback is allowed to stand in", () => {
  const readOf = async (written: string) => decodeStringLiteralOrRaw(await specifierNode(written))

  it.each([
    ["a plain literal as itself", '"./m"', "./m"],
    ["an escape as the character it names", `"./a${BACKSLASH}tb"`, "./a\tb"],
    ["an empty literal as empty, because it was read", '""', ""],
    ["a lone line continuation as empty, for the same reason", `"${BACKSLASH}\n"`, ""],
    ["a partial read as the part that parsed", `"a${BACKSLASH}uZZZZb"`, "a"],
    [
      "an unread literal as its source text, quotes off",
      `"${BACKSLASH}uZZZZ"`,
      `${BACKSLASH}uZZZZ`,
    ],
    ["a single-quoted unread literal the same way", `'${BACKSLASH}uZZZZ'`, `${BACKSLASH}uZZZZ`],
  ])("reads %s", async (_label, written, expected) => {
    expect(await readOf(written)).toBe(expected)
  })

  it("keeps two unread literals apart, which their decoded values cannot", async () => {
    const first = await readOf(`"${BACKSLASH}uZZZZ/a"`)
    const second = await readOf(`"${BACKSLASH}uZZZZ/b"`)

    expect(first).not.toBe(second)
  })
})

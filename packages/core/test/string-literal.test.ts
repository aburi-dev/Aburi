import { describe, expect, it } from "vitest"
import { decodeEscapeSequence } from "../src/index"

const BACKSLASH = "\\"

describe("the escapes that name a control character", () => {
  it.each([
    ["n", "\n"],
    ["t", "\t"],
    ["r", "\r"],
    ["b", "\b"],
    ["f", "\f"],
    ["v", "\v"],
    ["0", "\0"],
  ])("decodes %s", (body, expected) => {
    expect(decodeEscapeSequence(`${BACKSLASH}${body}`)).toBe(expected)
  })
})

describe("the escapes that quote a character", () => {
  it.each(['"', "'", BACKSLASH, "`", "$"])("decodes %s to itself, once", (char) => {
    expect(decodeEscapeSequence(`${BACKSLASH}${char}`)).toBe(char)
  })
})

describe("the numeric escapes", () => {
  it.each([
    [`${BACKSLASH}x62`, "b"],
    [`${BACKSLASH}x00`, "\0"],
    [`${BACKSLASH}xFF`, "ÿ"],
    [`${BACKSLASH}xff`, "ÿ"],
    [`${BACKSLASH}u0062`, "b"],
    [`${BACKSLASH}u00E9`, "é"],
    [`${BACKSLASH}u{62}`, "b"],
    [`${BACKSLASH}u{0}`, "\0"],
  ])("decodes %s", (raw, expected) => {
    expect(decodeEscapeSequence(raw)).toBe(expected)
  })

  it("decodes a braced escape above the BMP as the code point, not the low half of it", () => {
    const decoded = decodeEscapeSequence(`${BACKSLASH}u{1F600}`)

    expect(decoded).toBe("\u{1F600}")
    expect(decoded.length).toBe(2)
    expect([...decoded]).toHaveLength(1)
  })

  it("decodes the largest code point ECMAScript defines", () => {
    expect(decodeEscapeSequence(`${BACKSLASH}u{10FFFF}`)).toBe("\u{10ffff}")
  })

  it("keeps a braced escape above it, which the grammar still admits", () => {
    expect(decodeEscapeSequence(`${BACKSLASH}u{110000}`)).toBe("u{110000}")
    expect(decodeEscapeSequence(`${BACKSLASH}u{FFFFFFFFFF}`)).toBe("u{FFFFFFFFFF}")
  })

  it.each([
    [`${BACKSLASH}u{}`, "u{}"],
    [`${BACKSLASH}uZZZZ`, "uZZZZ"],
  ])("keeps %s, which the grammar refuses before it reaches here", (raw, expected) => {
    expect(decodeEscapeSequence(raw)).toBe(expected)
  })
})

describe("a line continuation contributes nothing", () => {
  it.each([
    ["LF", `${BACKSLASH}\n`],
    ["CRLF", `${BACKSLASH}\r\n`],
    ["CR", `${BACKSLASH}\r`],
    ["line separator", `${BACKSLASH}\u2028`],
    ["paragraph separator", `${BACKSLASH}\u2029`],
  ])("decodes a %s continuation to the empty string", (_label, raw) => {
    expect(decodeEscapeSequence(raw)).toBe("")
  })
})

describe("anything else keeps what the author typed", () => {
  it.each(["a", "z", "A", "/", ".", "-", "é"])("decodes an identity escape of %s", (char) => {
    expect(decodeEscapeSequence(`${BACKSLASH}${char}`)).toBe(char)
  })

  it.each([
    [`${BACKSLASH}1`, "1"],
    [`${BACKSLASH}01`, "01"],
    [`${BACKSLASH}7`, "7"],
    [`${BACKSLASH}8`, "8"],
    [`${BACKSLASH}9`, "9"],
  ])("keeps the digits of a digit escape (%s)", (raw, expected) => {
    expect(decodeEscapeSequence(raw)).toBe(expected)
  })

  it("returns a string carrying no escape unchanged", () => {
    expect(decodeEscapeSequence("ab")).toBe("ab")
  })

  it.each([
    ["nothing", ""],
    ["a lone backslash", BACKSLASH],
  ])("returns %s unchanged, which is too short to carry an escape", (_label, raw) => {
    expect(decodeEscapeSequence(raw)).toBe(raw)
  })
})

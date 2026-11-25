import { decodeStringLiteral } from "@aburi/core"
import type { Node } from "web-tree-sitter"

/**
 * The text between two JSX tags as React renders it, read child by child. The grammar splits a run
 * of text at each character reference where Babel cleans the whole run, so the pieces are joined
 * before the run is cleaned. A container holding only spaces, `{" "}`, is the space a formatter
 * writes where it breaks a line after meaningful text, and reads as that space.
 */
export class JsxTextRun {
  private raw = ""
  private cleaned = ""

  /** Whether the child is text, which the run holds until `flush`. */
  takes(child: Node): boolean {
    if (child.type === "jsx_text" || child.type === "html_character_reference") {
      this.raw += child.text
      return true
    }
    const spaces = jsxSpaces(child)
    if (spaces === null) return false
    this.cleaned += cleanJsxText(this.raw) + spaces
    this.raw = ""
    return true
  }

  flush(): string {
    const text = this.cleaned + cleanJsxText(this.raw)
    this.raw = ""
    this.cleaned = ""
    return text
  }
}

function jsxSpaces(child: Node): string | null {
  if (child.type !== "jsx_expression") return null
  const held = child.namedChildren.filter((part) => part !== null && part.type !== "comment")
  if (held.length !== 1 || held[0]?.type !== "string") return null
  return /^(["'])( +)\1$/.exec(held[0].text)?.[2] ?? null
}

/**
 * The text between JSX tags as React renders it: a line break and the indentation around it are
 * layout, and a line holding nothing else is dropped, so a formatter's re-wrapping reads alike.
 */
export function cleanJsxText(text: string): string {
  const lines = text.split(/\r\n|\n|\r/)
  let lastNonEmpty = 0
  for (const [index, line] of lines.entries()) {
    if (/[^ \t]/.test(line)) lastNonEmpty = index
  }
  let out = ""
  for (const [index, line] of lines.entries()) {
    let trimmed = line.replace(/\t/g, " ")
    if (index !== 0) trimmed = trimmed.replace(/^ +/, "")
    if (index !== lines.length - 1) trimmed = trimmed.replace(/ +$/, "")
    if (trimmed.length === 0) continue
    out += index === lastNonEmpty ? trimmed : `${trimmed} `
  }
  return out
}

/**
 * A string literal written as its value between `"`, so the quotes a formatter picks and the
 * escapes it adds or takes off to avoid them read alike: `'it\'s'` and `"it's"` are one string.
 * A character a reader cannot see, or that the collapse of whitespace would merge with a space,
 * stays escaped. A literal holding an escape ECMAScript gives no value in a module is kept as
 * written, since decoding it would put a value in the IR the source does not have.
 */
export function canonicalString(node: Node): string {
  const value = stringValueOf(node)
  return value === null ? node.text : quoted(value)
}

/** A JSX attribute's string, which holds no escapes: quoted with `"` unless its content has one. */
export function canonicalJsxAttributeString(text: string): string {
  if (text.length < 2 || !text.startsWith("'") || !text.endsWith("'")) return text
  const content = text.slice(1, -1)
  return content.includes('"') ? text : `"${content}"`
}

/** What a string literal holds, or null where `canonicalString` keeps the literal as written. */
export function stringValueOf(node: Node): string | null {
  if (node.type !== "string" || !node.isNamed || node.hasError) return null
  for (const part of node.namedChildren) {
    if (part?.type === "escape_sequence" && !hasValue(part.text)) return null
  }
  const { value, whole } = decodeStringLiteral(node)
  return whole ? value : null
}

function hasValue(sequence: string): boolean {
  if (/^\\(?:[1-9]|0\d)/.test(sequence)) return false
  const braced = /^\\u\{([0-9a-fA-F]+)\}$/.exec(sequence)
  return braced?.[1] === undefined || Number.parseInt(braced[1], 16) <= 0x10ffff
}

function quoted(value: string): string {
  return JSON.stringify(value).replace(UNSEEN, (character) => {
    const code = character.codePointAt(0) ?? 0
    const hex = code.toString(16)
    return code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`
  })
}

// JSON.stringify escapes the C0 controls; the other controls, the format characters and every
// whitespace character but the space are left to this.
const UNSEEN = /(?! )[\p{Z}\p{Cc}\p{Cf}]/gu

/** `new A`, which calls `A` with no arguments, as `new A()` does. */
export function isBareNew(node: Node): boolean {
  if (node.type !== "new_expression" || node.hasError) return false
  const constructed = node.childForFieldName("constructor")
  return (
    constructed !== null && !constructed.isMissing && node.childForFieldName("arguments") === null
  )
}

/**
 * A number with the letter case a formatter may rewrite settled, and for a decimal its exponent
 * and its leading and trailing zeros too: `0XFF` reads as `0xff`, `1.50` as `1.5`, `.5E+01` as
 * `0.5e1` and `1e0` as `1`.
 */
export function canonicalNumber(text: string): string {
  if (/^[\d_]+n?$/.test(text)) return text
  const lower = text.toLowerCase()
  if (/^0[box]/.test(lower) || lower.endsWith("n")) return lower
  return lower
    .replace(/^([\d.]+e)(?:\+|(-))?0*(\d)/, "$1$2$3")
    .replace(/^([\d.]+)e[+-]?0+$/, "$1")
    .replace(/^\./, "0.")
    .replace(/(\.\d*?)0+(?=e|$)/, "$1")
    .replace(/\.(?=e|$)/, "")
}

/**
 * The name a quoted property key spells when the quotes are not needed: `{ "a": 1 }` and
 * `{ a: 1 }` declare the same property, and a formatter's quote-props setting picks either.
 */
export function unquotedKey(node: Node): string | null {
  if (node.type !== "string" || !isKeyPosition(node)) return null
  const name = stringValueOf(node)
  return name !== null && IDENTIFIER_NAME.test(name) ? name : null
}

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/

/** Whether a node of this type names a property, a member or an enum member with a string. */
export function holdsKeys(type: string): boolean {
  return type === "enum_body" || KEY_FIELDS.has(type)
}

/** Whether a string names a property, a member or an enum member rather than holding a value. */
export function isKeyPosition(node: Node): boolean {
  const parent = node.parent
  if (parent === null) return false
  if (parent.type === "enum_body") return true
  const field = KEY_FIELDS.get(parent.type)
  return field !== undefined && parent.childForFieldName(field)?.id === node.id
}

const KEY_FIELDS: ReadonlyMap<string, string> = new Map([
  ["pair", "key"],
  ["pair_pattern", "key"],
  ["method_definition", "name"],
  ["method_signature", "name"],
  ["abstract_method_signature", "name"],
  ["public_field_definition", "name"],
  ["property_signature", "name"],
  ["enum_assignment", "name"],
])

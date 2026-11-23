import type { Node } from "web-tree-sitter"

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

/** A string quoted with `"` wherever the content reads the same between either delimiter. */
export function canonicalString(text: string): string {
  if (text.length < 2 || !text.startsWith("'") || !text.endsWith("'")) return text
  const content = text.slice(1, -1)
  if (content.includes('"') || content.includes("\\'")) return text
  return `"${content}"`
}

/**
 * A decimal number with the letter case, the exponent and the leading and trailing zeros a
 * formatter may rewrite settled: `1.50` reads as `1.5`, and `.5E+01` as `0.5e1`.
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
  const content = node.namedChildren
  if (content.length !== 1 || content[0]?.type !== "string_fragment") return null
  const name = content[0].text
  return IDENTIFIER_NAME.test(name) ? name : null
}

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/

/** Whether a node of this type names a property, a member or an enum member with a string. */
export function holdsKeys(type: string): boolean {
  return type === "enum_body" || KEY_FIELDS.has(type)
}

function isKeyPosition(node: Node): boolean {
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

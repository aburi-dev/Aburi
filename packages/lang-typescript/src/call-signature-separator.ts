import type { Tree } from "web-tree-sitter"
import type { Patch } from "./reparse"

/**
 * A `;` in place of the last blank before each generic call signature that opens a line and that
 * the grammar did not read as one. TypeScript reads no type arguments across a line break, so
 * `(): S` above `<U>(f: F<U>): U` are two members; the grammar reads `S<U>` and breaks the type.
 */
export function callSignatureSeparators(tree: Tree, source: string): Patch[] {
  const patches: Patch[] = []
  for (let at = 0; at < source.length; at = nextLineStart(source, at)) {
    const open = firstNonBlank(source, at)
    if (open === at || !isSignatureOpening(source, open) || !followsMember(source, at)) continue
    if (opensCallSignature(tree, open)) continue
    patches.push(separatorBefore(open))
  }
  return patches
}

function opensCallSignature(tree: Tree, open: number): boolean {
  const signature = tree.rootNode.descendantForIndex(open, open + 1)?.parent?.parent
  return (
    signature?.type === "call_signature" &&
    signature.startIndex === open &&
    MEMBER_LISTS.has(signature.parent?.type ?? "")
  )
}

function separatorBefore(open: number): Patch {
  const start = open - 1
  return {
    start,
    end: open,
    text: ";",
    holds: (tree) => {
      const token = tree.rootNode.descendantForIndex(start, open)
      if (token === null || token.type !== ";" || token.startIndex !== start) return false
      const member = token.nextSibling
      return (
        MEMBER_LISTS.has(token.parent?.type ?? "") &&
        member?.type === "call_signature" &&
        member.startIndex === open
      )
    },
  }
}

const MEMBER_LISTS: ReadonlySet<string> = new Set(["object_type", "interface_body"])

function nextLineStart(source: string, from: number): number {
  const newline = source.indexOf("\n", from)
  return newline === -1 ? source.length : newline + 1
}

function firstNonBlank(source: string, from: number): number {
  let at = from
  while (source[at] === " " || source[at] === "\t") at++
  return at
}

// `<T`, `<const T` and a list broken after `<` open a type parameter list; `</`, `<>` and `<!` do not.
function isSignatureOpening(source: string, at: number): boolean {
  return source[at] === "<" && /^<(\s|[\p{ID_Start}$_])/u.test(source.slice(at, at + 2))
}

// After an opening bracket, a separator or an operator, the `<` continues the expression or type.
function followsMember(source: string, lineStart: number): boolean {
  const at = lastCodeIndex(source, lineStart)
  const last = source[at]
  if (last === undefined || CONTINUING.has(last)) return false
  return !(last === ">" && source[at - 1] === "=")
}

// Read off the text: recovery can lex a comment inside an ERROR as something else.
function lastCodeIndex(source: string, before: number): number {
  let at = before - 1
  for (;;) {
    while (at >= 0 && /\s/.test(source[at] ?? "")) at--
    if (source[at] === "/" && source[at - 1] === "*") {
      const open = source.lastIndexOf("/*", at - 2)
      if (open === -1) return at
      at = open - 1
      continue
    }
    const lineStart = source.lastIndexOf("\n", at) + 1
    const code = firstNonBlank(source, lineStart)
    if (code > at || !source.startsWith("//", code)) return at
    at = lineStart - 1
  }
}

const CONTINUING: ReadonlySet<string> = new Set([..."{([<,;:?|&=", ..."+-*/%!~^"])

import { decodeStringLiteralOrRaw } from "@aburi/core"
import type { Node, Tree } from "web-tree-sitter"
import type { Patch } from "./reparse"

/** Each import() type the grammar cannot place, as an identifier of its length. */
export function importTypePatches(tree: Tree): ImportTypePatch[] {
  return maskableImportTypes(tree).map((span) => ({
    ...span,
    text: "$".padEnd(span.end - span.start, "_"),
    holds: (candidate) => readsAsType(candidate, span),
  }))
}

export interface ImportTypePatch extends Patch {
  readonly specifier: string
}

/** Lets the import reader take the masked identifiers of `tree` for the import() types they are. */
export function rememberImportTypes(tree: Tree, patches: readonly ImportTypePatch[]): void {
  if (patches.length === 0) return
  MASKS.set(tree, new Map(patches.map((patch) => [patch.start, patch.specifier])))
}

export function maskedImportSpecifier(node: Node): string | undefined {
  return MASKS.get(node.tree)?.get(node.startIndex)
}

export function masksImportTypes(tree: Tree): boolean {
  return MASKS.has(tree)
}

const MASKS = new WeakMap<Tree, Map<number, string>>()

interface Span {
  start: number
  end: number
  specifier: string
}

function maskableImportTypes(tree: Tree): Span[] {
  const spans: Span[] = []
  const root = tree.rootNode
  const stack: { node: Node; broken: boolean }[] = [{ node: root, broken: root.isError }]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, broken } = item
    const specifier = broken ? maskableSpecifier(node) : null
    if (specifier !== null) spans.push({ start: node.startIndex, end: node.endIndex, specifier })
    for (const child of node.namedChildren) {
      if (child === null || !(broken || child.hasError)) continue
      const childBroken = STATEMENT.test(child.type) ? child.hasError : broken || child.isError
      stack.push({ node: child, broken: childBroken })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

const STATEMENT = /_(statement|declaration|definition|signature)$/

function maskableSpecifier(node: Node): string | null {
  if (node.type !== "call_expression") return null
  if (node.childForFieldName("function")?.type !== "import") return null
  const args = node
    .childForFieldName("arguments")
    ?.namedChildren.filter((n) => n?.type !== "comment")
  if (args === undefined || args.length === 0 || args.length > 2) return null
  if (args.length === 2 && args[1]?.type !== "object") return null
  const first = args[0]
  if (first?.type !== "string" || /[\r\n\u2028\u2029]/.test(node.text)) return null
  const specifier = decodeStringLiteralOrRaw(first)
  return specifier === "" ? null : specifier
}

function readsAsType(tree: Tree, span: Span): boolean {
  let node: Node | null = tree.rootNode.namedDescendantForIndex(span.start, span.end)
  if (node === null || node.type !== "identifier") return false
  if (node.startIndex !== span.start || node.endIndex !== span.end) return false
  let parent: Node | null = node.parent
  while (
    parent !== null &&
    (parent.type === "member_expression" || parent.type === "nested_identifier") &&
    parent.namedChild(0)?.id === node.id
  ) {
    node = parent
    parent = parent.parent
  }
  if (parent === null) return false
  if (parent.type === "type_query") return true
  return parent.type === "nested_type_identifier" && parent.namedChild(0)?.id === node.id
}

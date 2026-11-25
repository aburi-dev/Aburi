import { asSyntaxNode, type SyntaxNode, unwrapValue, walkReceiverChain } from "@aburi/core"
import {
  FUNCTION_SCOPE_TYPES,
  findReturnedJsxElementNames,
  findReturnedValues,
  hasJsxReturn,
  isProviderElementName,
} from "./jsx"

const COMPONENT_VALUE_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
  "class",
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
])

const COMPONENT_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
])

/** The gate React itself uses to tell `<Foo />` from an HTML element. */
export function isPascalCase(leaf: string): boolean {
  if (leaf.length === 0) return false
  const first = leaf.charCodeAt(0)
  return first >= 0x41 && first <= 0x5a
}

export function matchesHocNaming(leaf: string): boolean {
  return /^with[A-Z]/.test(leaf)
}

/**
 * What the function's own returns hand back that a HOC's would: `"component"` for a function or a
 * class, written there or declared in the body under the name returned; else `"call"` for a call
 * not made through one of `parameters`, which may give back a component; else `null`.
 */
export function hocReturn(body: unknown, parameters: ReadonlySet<string>): HocReturn | null {
  const node = asSyntaxNode(body)
  if (node === null) return null
  const declared = node.type === "statement_block" ? declarationsIn(node) : new Map()
  let returned: HocReturn | null = null
  for (const written of findReturnedValues(node)) {
    const value = valueOfName(unwrapValue(written), declared)
    if (COMPONENT_VALUE_TYPES.has(value.type)) return "component"
    if (value.type === "call_expression" && !parameters.has(walkReceiverChain(value).root.text)) {
      returned = "call"
    }
  }
  return returned
}

export type HocReturn = "component" | "call"

function valueOfName(value: SyntaxNode, declared: ReadonlyMap<string, SyntaxNode>): SyntaxNode {
  return value.type === "identifier" ? (declared.get(value.text) ?? value) : value
}

// By name, what the body's own declarations bind, a nested function's aside.
function declarationsIn(
  node: SyntaxNode,
  into: Map<string, SyntaxNode> = new Map(),
): Map<string, SyntaxNode> {
  for (const child of node.namedChildren) {
    if (child === null) continue
    if (COMPONENT_DECLARATION_TYPES.has(child.type)) {
      const name = child.childForFieldName("name")
      if (name !== null) into.set(name.text, child)
    } else if (child.type === "variable_declarator") {
      const name = child.childForFieldName("name")
      const value = child.childForFieldName("value")
      if (name?.type === "identifier" && value !== null) into.set(name.text, unwrapValue(value))
    } else if (!FUNCTION_SCOPE_TYPES.has(child.type)) {
      declarationsIn(child, into)
    }
  }
  return into
}

export function returnsContextProvider(body: unknown): boolean {
  return findReturnedJsxElementNames(body).some(isProviderElementName)
}

export function returnsJsx(body: unknown): boolean {
  return hasJsxReturn(body)
}

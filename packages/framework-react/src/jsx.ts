import { asSyntaxNode, findNamedChildOfType, type SyntaxNode, unwrapValue } from "@aburi/core"

const JSX_NODE_TYPES: ReadonlySet<string> = new Set([
  "jsx_element",
  "jsx_self_closing_element",
  "jsx_fragment",
  "jsx_opening_element",
])

const JSX_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  "jsx_element",
  "jsx_self_closing_element",
  "jsx_fragment",
])

/** Node types that open a new function scope: a nested arrow's return is not the enclosing body's. */
export const FUNCTION_SCOPE_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "generator_function_declaration",
  "generator_function",
  "method_definition",
])

const FALLBACK_OPERATORS: ReadonlySet<string> = new Set(["||", "??"])

/**
 * Whether the function hands back what React renders: an element or a fragment, an array of them,
 * `children`, an element factory's call, or a `.map` / `useMemo` whose callback hands one back,
 * read through conditionals, `&&` / `||` / `??`, and the names the body binds.
 */
export function hasJsxReturn(body: unknown): boolean {
  const node = asSyntaxNode(body)
  if (node === null) return false
  return findReturnedValues(node).some((value) => rendersElement(value, node, new Set()))
}

/** Whether JSX is written anywhere under `node`, a nested function's included. */
export function containsJsx(node: unknown): boolean {
  const syntax = asSyntaxNode(node)
  return syntax !== null && findFirstJsxDescendant(syntax) !== null
}

/** The values the function's own `return`s hand back. */
export function findReturnedValues(body: unknown): SyntaxNode[] {
  const node = asSyntaxNode(body)
  if (node === null) return []
  // A concise arrow's body is the value it returns.
  if (node.type !== "statement_block") return [node]
  const values: SyntaxNode[] = []
  collectReturnedValues(node, values)
  return values
}

export function findReturnedJsxElementNames(body: unknown): string[] {
  const elements: SyntaxNode[] = []
  for (const value of findReturnedValues(body)) collectReturnedElements(value, elements)
  return elements.map(jsxElementName).filter((name) => name !== null)
}

export function findReturnedJsxElementName(body: unknown): string | null {
  return findReturnedJsxElementNames(body)[0] ?? null
}

export function isProviderElementName(name: string | null): boolean {
  if (name === null || name === "") return false
  const dot = name.lastIndexOf(".")
  if (dot < 0) return false
  return name.slice(dot + 1) === "Provider"
}

const ELEMENT_FACTORIES: ReadonlySet<string> = new Set([
  "createElement",
  "cloneElement",
  "createPortal",
])

/** Calls whose result is what a function argument of theirs hands back, element for element. */
const CALLBACK_RESULT_CALLS: ReadonlySet<string> = new Set(["map", "flatMap", "useMemo"])

const FUNCTION_VALUE_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression"])

function rendersElement(expression: SyntaxNode, scope: SyntaxNode, seen: Set<string>): boolean {
  const value = unwrapValue(expression)
  if (JSX_ELEMENT_TYPES.has(value.type)) return true
  switch (value.type) {
    case "array":
      return value.namedChildren.some(
        (element) => element !== null && rendersElement(element, scope, seen),
      )
    case "spread_element": {
      const spread = value.namedChildren[0]
      return spread !== null && spread !== undefined && rendersElement(spread, scope, seen)
    }
    case "identifier":
      return rendersBinding(value.text, scope, seen)
    case "member_expression":
      return value.childForFieldName("property")?.text === "children"
    case "call_expression":
      return rendersCall(value)
    default:
      return branchesOf(value).some(
        (branch) => branch !== null && rendersElement(branch, scope, seen),
      )
  }
}

// `children` a parameter or a prop binds is whatever the caller rendered.
function rendersBinding(name: string, scope: SyntaxNode, seen: Set<string>): boolean {
  if (seen.has(name)) return false
  seen.add(name)
  const values = boundValues(name, scope)
  if (values.length === 0) return name === "children"
  return values.some((value) => rendersElement(value, scope, seen))
}

/** What the body's own declarators and assignments give `name`, a nested function's aside. */
function boundValues(name: string, node: SyntaxNode, into: SyntaxNode[] = []): SyntaxNode[] {
  for (const child of node.namedChildren) {
    if (child === null || FUNCTION_SCOPE_TYPES.has(child.type)) continue
    if (child.type === "variable_declarator" || child.type === "assignment_expression") {
      const target = child.childForFieldName(child.type === "variable_declarator" ? "name" : "left")
      const value = child.childForFieldName(
        child.type === "variable_declarator" ? "value" : "right",
      )
      if (target?.type === "identifier" && target.text === name && value !== null) into.push(value)
    }
    boundValues(name, child, into)
  }
  return into
}

function rendersCall(call: SyntaxNode): boolean {
  const callee = call.childForFieldName("function")
  const leaf =
    callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : callee?.text
  if (leaf === undefined) return false
  if (ELEMENT_FACTORIES.has(leaf)) return true
  if (!CALLBACK_RESULT_CALLS.has(leaf)) return false
  const args = call.childForFieldName("arguments")?.namedChildren ?? []
  return args.some(
    (arg) =>
      arg !== null &&
      FUNCTION_VALUE_TYPES.has(unwrapValue(arg).type) &&
      hasJsxReturn(unwrapValue(arg).childForFieldName("body")),
  )
}

function findFirstJsxDescendant(node: SyntaxNode): SyntaxNode | null {
  if (JSX_NODE_TYPES.has(node.type)) return node
  for (const child of node.children) {
    if (child === null) continue
    const found = findFirstJsxDescendant(child)
    if (found !== null) return found
  }
  return null
}

function collectReturnedValues(node: SyntaxNode, into: SyntaxNode[]): void {
  if (node.type === "return_statement") {
    for (const child of node.namedChildren) if (child !== null) into.push(child)
    return
  }
  if (FUNCTION_SCOPE_TYPES.has(node.type)) return
  for (const child of node.namedChildren) if (child !== null) collectReturnedValues(child, into)
}

function collectReturnedElements(expression: SyntaxNode, into: SyntaxNode[]): void {
  const value = unwrapValue(expression)
  if (JSX_ELEMENT_TYPES.has(value.type)) into.push(value)
  for (const branch of branchesOf(value)) if (branch !== null) collectReturnedElements(branch, into)
}

function branchesOf(value: SyntaxNode): (SyntaxNode | null)[] {
  switch (value.type) {
    case "ternary_expression":
      return [value.childForFieldName("consequence"), value.childForFieldName("alternative")]
    case "binary_expression": {
      const operator = value.childForFieldName("operator")?.type ?? ""
      const left = value.childForFieldName("left")
      // An element is never falsy or nullish: `a && b` can only yield an element as `b`, and
      // `<A /> || b` and `<A /> ?? b` always yield `<A />`.
      if (operator === "&&") return [value.childForFieldName("right")]
      if (!FALLBACK_OPERATORS.has(operator)) return []
      if (left !== null && JSX_ELEMENT_TYPES.has(unwrapValue(left).type)) return [left]
      return [left, value.childForFieldName("right")]
    }
    default:
      return []
  }
}

function jsxElementName(node: SyntaxNode): string | null {
  if (node.type === "jsx_fragment") return null
  if (node.type === "jsx_self_closing_element") {
    const name = node.childForFieldName("name")
    return name === null ? null : name.text
  }
  const opening =
    node.childForFieldName("open_tag") ?? findNamedChildOfType(node, "jsx_opening_element")
  if (opening === null) return null
  const name = opening.childForFieldName("name")
  return name === null ? null : name.text
}

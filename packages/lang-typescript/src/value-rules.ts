import { lastQnameSegment } from "@aburi/core"
import type { Rule, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild, walkDescendants } from "./ast-helpers"
import { makeRule, ruleText } from "./rules"

export function declaredValueRules(symbol: SymbolCandidate<Node>): Rule[] {
  // An enum merges with a namespace written before or after it, so the declarations are told apart
  // by their own type rather than by the Symbol's kind.
  const declarations = [
    symbol.fullNode,
    ...(symbol.mergedDeclarations ?? []).map((d) => d.fullNode),
  ]
  const enums = declarations.flatMap((declaration) => {
    const found = enumDeclarationOf(declaration)
    return found === null ? [] : [found]
  })
  if (enums.length > 0) return enums.flatMap(enumMemberRules)
  if (symbol.kind !== "const" || symbol.bodyNode !== null) return []
  if (symbol.derivedBy.includes("destructured-binding")) return []
  const value = initializerOf(symbol.fullNode, lastQnameSegment(symbol.name))
  return value === null || !holdsValue(value) ? [] : [valueRule(value)]
}

export function objectEntryValueRule(entry: Node): Rule | null {
  if (entry.type === "comment") return null
  const value = entry.type === "pair" ? entry.childForFieldName("value") : entry
  return value === null || !holdsValue(value) ? null : valueRule(entry)
}

function enumDeclarationOf(declaration: Node): Node | null {
  let node: Node | null = declaration
  while (node?.type === "export_statement" || node?.type === "ambient_declaration") {
    node =
      node.type === "export_statement"
        ? node.childForFieldName("declaration")
        : (node.namedChildren.find((child) => child !== null && child.type !== "comment") ?? null)
  }
  return node?.type === "enum_declaration" ? node : null
}

function enumMemberRules(declaration: Node): Rule[] {
  const body = declaration.childForFieldName("body") ?? findChild(declaration, "enum_body")
  if (body === null) return []
  return body.namedChildren.flatMap((member) =>
    member === null || member.type === "comment" ? [] : [valueRule(member)],
  )
}

function initializerOf(statement: Node, name: string): Node | null {
  const declaration =
    statement.type === "export_statement" ? statement.childForFieldName("declaration") : statement
  for (const declarator of declaration?.namedChildren ?? []) {
    if (declarator?.type !== "variable_declarator") continue
    if (declarator.childForFieldName("name")?.text !== name) continue
    return declarator.childForFieldName("value")
  }
  return null
}

// A function's body is walked for rules of its own, and which function a call calls, and with what,
// moves `syntax` alone, so a value holding either anywhere would read them twice or read them at all.
const NOT_A_VALUE_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "await_expression",
  "call_expression",
  "class",
  "function_expression",
  "generator_function",
  "method_definition",
  "new_expression",
])

function holdsValue(value: Node): boolean {
  for (const node of walkDescendants(value)) if (NOT_A_VALUE_TYPES.has(node.type)) return false
  return true
}

function valueRule(node: Node): Rule {
  return makeRule("value", node, { expr: ruleText(node) })
}

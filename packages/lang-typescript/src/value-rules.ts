import { unwrapValue } from "@aburi/core"
import type { Rule, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild } from "./ast-helpers"
import { makeRule, ruleText } from "./rules"

/**
 * The values a declaration with no body of its own holds: an enum's members, and the initializer of
 * a variable that is neither a function, a class, an object literal nor a call, whose arguments the
 * call's own record carries.
 */
export function declaredValueRules(symbol: SymbolCandidate<Node>): Rule[] {
  if (symbol.kind === "enum") {
    const declarations = [
      symbol.fullNode,
      ...(symbol.mergedDeclarations ?? []).map((d) => d.fullNode),
    ]
    return declarations.flatMap(enumMemberRules)
  }
  if (symbol.kind !== "const" || symbol.bodyNode !== null) return []
  if (symbol.derivedBy.includes("destructured-binding")) return []
  const value = initializerOf(symbol.fullNode, lastSegment(symbol.name))
  return value === null || !holdsValue(value) ? [] : [valueRule(value)]
}

/** A value rule for an object literal's entry that no Symbol of its own holds. */
export function objectEntryValueRule(entry: Node): Rule | null {
  if (entry.type === "comment") return null
  const value = entry.type === "pair" ? entry.childForFieldName("value") : entry
  return value === null || !holdsValue(value) ? null : valueRule(entry)
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

function holdsValue(value: Node): boolean {
  const inner = unwrapValue(value)
  return inner.type !== "call_expression" && inner.type !== "new_expression"
}

function valueRule(node: Node): Rule {
  return makeRule("value", node, { expr: ruleText(node) })
}

function lastSegment(qname: string): string {
  return qname.slice(qname.lastIndexOf(".") + 1)
}

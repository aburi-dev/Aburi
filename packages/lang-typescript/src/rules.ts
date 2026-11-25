import { normalizeRuleText, RULE_TEXT_LIMIT } from "@aburi/core"
import type { Rule } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { throughParentheses } from "./ast-helpers"
import { wrappedExpression } from "./callee"
import { canonicalText } from "./canonical-text"

export const LOOP_KINDS: ReadonlyMap<string, NonNullable<Rule["loopKind"]>> = new Map([
  ["for_statement", "for"],
  ["for_in_statement", "for"],
  ["while_statement", "while"],
  ["do_statement", "do"],
])

export function makeRule(
  type: Rule["type"],
  node: Node,
  overrides: Partial<Pick<Rule, "condition" | "what" | "expr" | "loopKind">> = {},
): Rule {
  return {
    type,
    line: node.startPosition.row + 1,
    condition: overrides.condition ?? null,
    what: overrides.what ?? null,
    expr: overrides.expr ?? null,
    loopKind: overrides.loopKind ?? null,
  }
}

export function ruleText(
  node: Node,
  from: number = node.startIndex,
  to: number = node.endIndex,
): string {
  return normalizeRuleText(canonicalText(node, from, to, RULE_TEXT_READ))
}

// The text is cut at the limit, so the tokens past it are left unread: a code point spans at most
// two UTF-16 units, and the last token read may be a separator the next one would drop.
const RULE_TEXT_READ = 2 * (RULE_TEXT_LIMIT + 2)

export function conditionText(condition: Node): string {
  const open = condition.child(0)
  const close = condition.child(condition.childCount - 1)
  if (
    condition.type !== "parenthesized_expression" ||
    open?.type !== "(" ||
    close?.type !== ")" ||
    open.equals(close)
  ) {
    return ruleText(condition)
  }
  return ruleText(condition, open.endIndex, close.startIndex)
}

export function isTrivialExpr(node: Node): boolean {
  switch (node.type) {
    case "number":
    case "string":
    case "true":
    case "false":
    case "null":
    case "undefined":
    case "identifier":
    case "this":
    case "super":
      return true
    case "member_expression": {
      const object = node.childForFieldName("object")
      return object !== null && isTrivialExpr(object)
    }
    case "subscript_expression": {
      const object = node.childForFieldName("object")
      const index = node.childForFieldName("index")
      if (object === null || index === null) return false
      return isTrivialExpr(object) && isTrivialExpr(withoutTypeWrappers(index))
    }
    case "unary_expression":
    case "update_expression": {
      const argument = node.childForFieldName("argument") ?? node.namedChild(0)
      return argument !== null && isTrivialExpr(argument)
    }
    case "parenthesized_expression": {
      const inner = throughParentheses(node)
      return inner !== node && isTrivialExpr(inner)
    }
    default:
      return false
  }
}

const TYPE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "non_null_expression",
  "as_expression",
  "satisfies_expression",
  "type_assertion",
])

function withoutTypeWrappers(index: Node): Node {
  let cursor = index
  while (TYPE_WRAPPER_TYPES.has(cursor.type) || cursor.type === "parenthesized_expression") {
    const inner = wrappedExpression(cursor)
    if (inner === null) return cursor
    cursor = inner
  }
  return cursor
}

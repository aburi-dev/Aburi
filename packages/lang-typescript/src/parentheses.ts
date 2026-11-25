import type { Node } from "web-tree-sitter"
import { hasErrorChild } from "./ast-helpers"

/**
 * The expression or type a pair of parentheses holds when the program parses the same without
 * them: the parentheses a formatter wraps around JSX laid out over lines, or takes off where
 * precedence already groups the operands, are a spelling, not the code.
 */
export function redundantlyParenthesized(node: Node): Node | null {
  if (node.type === "parenthesized_type") return redundantTypeParentheses(node)
  if (node.type !== "parenthesized_expression") return null
  const held = soleExpression(node)
  const parent = node.parent
  if (held === null || parent === null || STATEMENT_PARENTHESES.has(parent.type)) return null
  if (precedesNonNull(node)) return null
  if (parent.type === "parenthesized_expression") {
    return soleExpression(parent) === null ? null : held
  }
  const inner = innermost(held)
  if (inner === null || opensAmbiguously(node, parent, inner)) return null
  return isGroupedAlike(node, parent, inner) ? held : null
}

// The grammar reads `x || (a?.b)!.c` as `(x || (a?.b))!.c`, where TypeScript asserts `(a?.b)` alone,
// and without the parentheses `a?.b!.c` goes on with the chain, so those a `!` follows are kept.
function precedesNonNull(node: Node): boolean {
  for (let cursor = node.parent; cursor !== null; cursor = cursor.parent) {
    if (cursor.type === "non_null_expression") {
      return cursor.firstNamedChild?.endIndex === node.endIndex
    }
    if (cursor.endIndex !== node.endIndex) return false
  }
  return false
}

// A type that binds tighter than any operator reads the same without the parentheses around it, in
// any position: `(A)[]` is `A[]`, where `(A | B)[]` and `(keyof T)[]` are not.
function redundantTypeParentheses(node: Node): Node | null {
  const held = soleExpression(node)
  return held !== null && PRIMARY_TYPE_TYPES.has(held.type) ? held : null
}

const PRIMARY_TYPE_TYPES: ReadonlySet<string> = new Set([
  "type_identifier",
  "nested_type_identifier",
  "generic_type",
  "predefined_type",
  "literal_type",
  "template_literal_type",
  "this_type",
  "object_type",
  "tuple_type",
  "array_type",
  "lookup_type",
  "parenthesized_type",
])

/**
 * The operand to write between parentheses whether or not the source does: where operators that
 * readers mix up meet (`&&` and `||`, a bitwise operator and any other, `%` and arithmetic, `await`
 * inside a binary operator), a spread takes more than one term, a branch holds `??`, `as` or
 * `satisfies`, or an arrow returns a conditional, the grouping is spelled out, as formatters do,
 * so leaving those parentheses out reads the same as writing them.
 */
export function clarifiedOperand(parent: Node, child: Node): Node | null {
  if (!CLARIFIED_PARENTS.has(parent.type) || !child.isNamed || child.isExtra) return null
  let operand = child
  for (let held = redundantlyParenthesized(operand); held !== null; ) {
    operand = held
    held = redundantlyParenthesized(operand)
  }
  if (operand.type === "parenthesized_expression") return null
  if (parent.type === "spread_element") return levelOf(operand) < UNARY ? operand : null
  switch (parent.type) {
    case "ternary_expression": {
      const branch = !holds(parent, "condition", child)
      return branch && isNullishOrAssertion(operand) ? operand : null
    }
    case "arrow_function":
      return holds(parent, "body", child) && operand.type === "ternary_expression" ? operand : null
    default: {
      if (operand.type === "await_expression") return operand
      if (operand.type !== "binary_expression") return null
      return mixesUp(operatorOf(parent), operatorOf(operand)) ? operand : null
    }
  }
}

const CLARIFIED_PARENTS: ReadonlySet<string> = new Set([
  "binary_expression",
  "spread_element",
  "ternary_expression",
  "arrow_function",
])

function isNullishOrAssertion(node: Node): boolean {
  if (node.type === "as_expression" || node.type === "satisfies_expression") return true
  return node.type === "binary_expression" && operatorOf(node) === "??"
}

function operatorOf(binary: Node): string {
  return binary.childForFieldName("operator")?.type ?? ""
}

function mixesUp(outer: string, inner: string): boolean {
  const among = (operators: ReadonlySet<string>) => operators.has(outer) && operators.has(inner)
  if (outer === inner) return outer === "**" || EQUALITY.has(outer) || SHIFTS.has(outer)
  if (BITWISE.has(outer) || BITWISE.has(inner)) return true
  if (inner === "%") return ARITHMETIC.has(outer)
  return among(LOGICAL) || among(MULTIPLICATIVE) || among(EQUALITY) || among(SHIFTS)
}

const LOGICAL: ReadonlySet<string> = new Set(["&&", "||"])
const BITWISE: ReadonlySet<string> = new Set(["|", "^", "&"])
const EQUALITY: ReadonlySet<string> = new Set(["==", "!=", "===", "!=="])
const SHIFTS: ReadonlySet<string> = new Set(["<<", ">>", ">>>"])
const MULTIPLICATIVE: ReadonlySet<string> = new Set(["*", "/", "%"])
const ARITHMETIC: ReadonlySet<string> = new Set(["+", "-", "*", "/"])

// The parentheses `if`, `while`, `do`, `switch` and `with` are written with belong to the statement.
const STATEMENT_PARENTHESES: ReadonlySet<string> = new Set([
  "if_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "with_statement",
])

// Parentheses the grammar repaired, or around an expression it repaired, are kept as written.
function soleExpression(node: Node): Node | null {
  if (hasErrorChild(node)) return null
  let held: Node | null = null
  for (const child of node.children) {
    if (child === null || child.type === "comment" || !child.isNamed) continue
    if (child.isExtra || held !== null) return null
    held = child
  }
  return held !== null && !hasErrorChild(held) ? held : null
}

function innermost(node: Node): Node | null {
  let cursor: Node | null = node
  while (cursor !== null && cursor.type === "parenthesized_expression") {
    cursor = soleExpression(cursor)
  }
  return cursor
}

function isGroupedAlike(node: Node, parent: Node, inner: Node): boolean {
  const level = levelOf(inner)
  if (ANY_EXPRESSION_PARENTS.has(parent.type)) return level > SEQUENCE
  const slots = ANY_EXPRESSION_FIELDS.get(parent.type)
  if (slots?.some((field) => holds(parent, field, node)) === true) {
    return level > SEQUENCE && !(parent.type === "variable_declarator" && isLoopHead(parent))
  }
  switch (parent.type) {
    case "binary_expression":
      return isRedundantOperand(parent, holds(parent, "left", node), inner, level)
    case "ternary_expression":
      return holds(parent, "condition", node) && level >= LOWEST_BINARY
    case "unary_expression":
    case "await_expression":
      return level >= UNARY
    case "update_expression":
      return level >= POSTFIX
    case "as_expression":
    case "satisfies_expression":
      return parent.firstNamedChild?.id === node.id && level >= UNARY
    case "member_expression":
    case "subscript_expression":
      return holds(parent, "object", node) && isChainHead(inner)
    case "call_expression":
      return holds(parent, "function", node) && isChainHead(inner)
    case "non_null_expression":
      return isChainHead(inner)
    case "new_expression":
      return holds(parent, "constructor", node) && isPlainName(inner)
    default:
      return false
  }
}

// A slot where only a sequence needs its parentheses.
const ANY_EXPRESSION_PARENTS: ReadonlySet<string> = new Set([
  "arguments",
  "array",
  "spread_element",
  "jsx_expression",
  "template_substitution",
  "return_statement",
  "throw_statement",
  "yield_expression",
])

const ANY_EXPRESSION_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["pair", ["value"]],
  ["subscript_expression", ["index"]],
  ["switch_case", ["value"]],
  ["for_in_statement", ["right"]],
  ["export_statement", ["value"]],
  ["assignment_expression", ["right"]],
  ["augmented_assignment_expression", ["right"]],
  ["variable_declarator", ["value"]],
  ["ternary_expression", ["consequence", "alternative"]],
  ["arrow_function", ["body"]],
])

function holds(parent: Node, field: string, child: Node): boolean {
  return parent.childForFieldName(field)?.id === child.id
}

// `in` inside the head of a `for` would end the initializer, so the parentheses there hold it.
function isLoopHead(declarator: Node): boolean {
  return declarator.parent?.parent?.type === "for_statement"
}

function isRedundantOperand(parent: Node, left: boolean, inner: Node, level: number): boolean {
  const operator = operatorOf(parent)
  const outer = BINARY_LEVELS.get(operator)
  if (outer === undefined) return false
  if (inner.type === "binary_expression" && mixesNullishWithLogical(operator, operatorOf(inner))) {
    return false
  }
  if (operator === "**") return left ? level >= POSTFIX : level >= outer
  return left ? level >= outer : level > outer
}

// `a ?? b || c` is a syntax error: the parentheses around either side are required.
function mixesNullishWithLogical(outer: string, inner: string): boolean {
  const logical = (operator: string) => operator === "||" || operator === "&&"
  return (outer === "??" && logical(inner)) || (inner === "??" && logical(outer))
}

const SEQUENCE = -1
const LOWEST_BINARY = 1
const UNARY = 13
const POSTFIX = 14
const PRIMARY = 15

const BINARY_LEVELS: ReadonlyMap<string, number> = new Map([
  ["??", 1],
  ["||", 2],
  ["&&", 3],
  ["|", 4],
  ["^", 5],
  ["&", 6],
  ["==", 7],
  ["!=", 7],
  ["===", 7],
  ["!==", 7],
  ["<", 8],
  [">", 8],
  ["<=", 8],
  [">=", 8],
  ["instanceof", 8],
  ["in", 8],
  ["<<", 9],
  [">>", 9],
  [">>>", 9],
  ["+", 10],
  ["-", 10],
  ["*", 11],
  ["/", 11],
  ["%", 11],
  ["**", 12],
])

const ASSIGNMENT_LEVEL_TYPES: ReadonlySet<string> = new Set([
  "assignment_expression",
  "augmented_assignment_expression",
  "arrow_function",
  "yield_expression",
  "ternary_expression",
  "as_expression",
  "satisfies_expression",
])

const PRIMARY_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "this",
  "super",
  "number",
  "string",
  "template_string",
  "regex",
  "true",
  "false",
  "null",
  "undefined",
  "array",
  "object",
  "jsx_element",
  "jsx_self_closing_element",
  "member_expression",
  "subscript_expression",
  "call_expression",
  "new_expression",
  "non_null_expression",
  "function_expression",
  "generator_function",
  "class",
  "meta_property",
])

function levelOf(node: Node): number {
  if (node.type === "sequence_expression") return SEQUENCE
  if (node.type === "binary_expression") {
    return BINARY_LEVELS.get(operatorOf(node)) ?? SEQUENCE
  }
  if (node.type === "unary_expression" || node.type === "await_expression") return UNARY
  if (node.type === "update_expression") {
    return node.firstChild?.isNamed === true ? POSTFIX : UNARY
  }
  if (PRIMARY_TYPES.has(node.type)) return PRIMARY
  if (ASSIGNMENT_LEVEL_TYPES.has(node.type)) return 0
  return SEQUENCE
}

// The head of a member access or a call reads the same bare only when no `?.` in it would then
// short-circuit the rest of the chain, and a number would swallow the `.` as its decimal point. A
// `new` is written with its argument list, so `(new A).b` is `new A().b`.
const CHAIN_HEAD_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "new_expression",
  "this",
  "super",
  "string",
  "template_string",
  "regex",
  "array",
  "member_expression",
  "subscript_expression",
  "call_expression",
  "non_null_expression",
])

function isChainHead(node: Node): boolean {
  let cursor: Node | null = node
  while (cursor !== null && CHAIN_HEAD_TYPES.has(cursor.type)) {
    if (cursor.children.some((child) => child?.type === "optional_chain")) return false
    const next: Node | null =
      cursor.childForFieldName("object") ??
      cursor.childForFieldName("function") ??
      (cursor.type === "non_null_expression" ? cursor.firstNamedChild : null)
    if (next === null) return true
    cursor = next
  }
  return false
}

// `new (a())()` constructs what `a()` returns, `new a()()` calls what `new a()` builds.
function isPlainName(node: Node): boolean {
  if (node.type === "identifier") return true
  if (node.type !== "member_expression") return false
  const object = node.childForFieldName("object")
  return object !== null && isPlainName(object)
}

// Bare at the start of a statement, a leading `{` opens a block, a leading `function`, `class` or
// `async function` a declaration, and a leading `let [` a declaration too; `export default` reads
// all of those but `{` the same way. In an arrow's body only `{` is read otherwise, and the other
// keywords are kept there as a precaution.
const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set(["{", "function", "class", "let", "async"])

const EXPORTED_KEYWORDS: ReadonlySet<string> = new Set(["function", "class", "let", "async"])

function opensAmbiguously(node: Node, parent: Node, inner: Node): boolean {
  const keyword = firstToken(inner)
  if (parent.type === "export_statement") return EXPORTED_KEYWORDS.has(keyword)
  return STATEMENT_KEYWORDS.has(keyword) && opensStatementOrArrowBody(node)
}

function firstToken(node: Node): string {
  let cursor: Node | null = node
  while (cursor !== null && cursor.childCount > 0) cursor = cursor.firstChild
  return cursor?.type ?? ""
}

function opensStatementOrArrowBody(node: Node): boolean {
  let cursor: Node = node
  for (;;) {
    const parent: Node | null = cursor.parent
    if (parent === null || parent.startIndex !== node.startIndex) {
      return parent?.type === "arrow_function" && holds(parent, "body", cursor)
    }
    if (parent.type === "expression_statement") return true
    if (parent.type === "arrow_function") return holds(parent, "body", cursor)
    cursor = parent
  }
}

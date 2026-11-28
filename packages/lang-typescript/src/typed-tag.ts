import type { Node } from "web-tree-sitter"
import { firstNonCommentChild } from "./ast-helpers"

/**
 * The grammar has no tagged template with type arguments (`` tag<T>`…` ``), which TypeScript reads
 * as a call of `tag`. Where the type arguments cannot be an expression (`` sql<Row[]>`…` ``), the
 * grammar completes the instantiation into a callable with a `!` the source does not hold, and an
 * `await` before the tag can land inside that instantiation.
 */
export interface TypedTagCompletion {
  readonly tag: Node
  readonly awaited: boolean
}

export function typedTagCompletion(callee: Node): TypedTagCompletion | null {
  if (callee.type !== "non_null_expression") return null
  if (callee.child(callee.childCount - 1)?.isMissing !== true) return null
  const call = callee.parent
  if (call?.type !== "call_expression") return null
  if (call.childForFieldName("function")?.equals(callee) !== true) return null
  if (call.childForFieldName("arguments")?.type !== "template_string") return null
  const instantiation = firstNonCommentChild(callee)
  if (instantiation?.type !== "instantiation_expression") return null
  const expression = firstNonCommentChild(instantiation)
  if (expression === null) return null
  if (expression.type !== "await_expression") return { tag: expression, awaited: false }
  const awaited = firstNonCommentChild(expression)
  return awaited === null ? null : { tag: awaited, awaited: true }
}

/**
 * Where the type arguments can be an expression (`` sql<number>`…` ``), the grammar reads
 * `(sql < number) > `…`` as two comparisons, which TypeScript never does before a template. A
 * chain written on the result (`` sql<number>`…`.mapWith(Number) ``) lands right of the `>`, with
 * the template at its head.
 */
export interface TypedTagComparison {
  readonly tag: Node
  readonly template: Node
  readonly awaited: boolean
}

export function typedTagComparison(node: Node): TypedTagComparison | null {
  if (node.type !== "binary_expression") return null
  if (node.childForFieldName("operator")?.type !== ">") return null
  const right = node.childForFieldName("right")
  const template = right === null ? null : chainHead(right)
  if (template?.type !== "template_string") return null
  const opened = node.childForFieldName("left")
  if (opened?.type !== "binary_expression") return null
  if (opened.childForFieldName("operator")?.type !== "<") return null
  const written = opened.childForFieldName("left")
  const typeArgument = opened.childForFieldName("right")
  if (written === null || typeArgument === null || !readsAsType(typeArgument)) return null
  // `await` binds tighter than `<`, so the grammar puts one written before the tag on the tag.
  const awaited = written.type === "await_expression"
  const tag = awaited ? firstNonCommentChild(written) : written
  if (tag === null || !TAG_TYPES.has(tag.type)) return null
  return { tag, template, awaited }
}

/** The comparison whose template heads the chain `template` is the head of, if any. */
export function typedTagOfTemplate(template: Node): TypedTagComparison | null {
  let node = template
  for (let parent = node.parent; parent !== null; node = parent, parent = parent.parent) {
    const field = CHAIN_FIELDS.get(parent.type)
    if (field !== undefined && parent.childForFieldName(field)?.equals(node) === true) continue
    if (parent.childForFieldName("right")?.equals(node) !== true) return null
    const typed = typedTagComparison(parent)
    return typed?.template.equals(template) === true ? typed : null
  }
  return null
}

const CHAIN_FIELDS: ReadonlyMap<string, string> = new Map([
  ["member_expression", "object"],
  ["subscript_expression", "object"],
  ["call_expression", "function"],
])

function chainHead(node: Node): Node {
  let head = node
  for (;;) {
    const field = CHAIN_FIELDS.get(head.type)
    const next = field === undefined ? null : head.childForFieldName(field)
    if (next === null) return head
    head = next
  }
}

// A tag is a left-hand-side expression: an operator before `<` would bind the type arguments to
// its right operand, not to the whole.
const TAG_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "member_expression",
  "subscript_expression",
  "call_expression",
  "parenthesized_expression",
  "non_null_expression",
  "this",
])

// Read as an expression, a type argument TypeScript also takes for a type: a name, a qualified
// name, or a literal type.
function readsAsType(node: Node): boolean {
  switch (node.type) {
    case "identifier":
    case "this":
    case "null":
    case "undefined":
    case "true":
    case "false":
    case "number":
    case "string":
      return true
    case "member_expression": {
      const object = node.childForFieldName("object")
      return (
        object !== null &&
        (object.type === "identifier" || object.type === "member_expression") &&
        readsAsType(object)
      )
    }
    default:
      return false
  }
}

import type { FrameworkCall } from "@aburi/types"
import { isQnameSegment } from "./id"
import { decodeStringLiteral } from "./string-literal"
import { type SyntaxNode, unwrapValue } from "./syntax-node"

/**
 * A call is left out, being one the Symbol's body already makes, and so is anything a name does
 * not spell, which no Symbol answers.
 */
export function referenceCalls(nodes: readonly SyntaxNode[]): FrameworkCall[] {
  return nodes.flatMap((written) => {
    const value = unwrapValue(written)
    const target = referenceTarget(value)
    return target === null ? [] : [{ target, line: value.startPosition.row + 1 }]
  })
}

function referenceTarget(node: SyntaxNode): string | null {
  const value = unwrapValue(node)
  if (value.type === "identifier") return value.text
  if (value.type !== "member_expression" && value.type !== "subscript_expression") return null
  const object = value.childForFieldName("object")
  const head = object === null ? null : referenceTarget(object)
  const segment = memberSegment(value)
  return head === null || segment === null ? null : `${head}.${segment}`
}

// A dotted name and a string key are spelled as a call target spells them, so the resolver matches
// the reference as it would a call through it.
function memberSegment(member: SyntaxNode): string | null {
  if (member.type === "member_expression") {
    const property = member.childForFieldName("property")
    return property?.type === "property_identifier" ? property.text : null
  }
  const index = member.childForFieldName("index")
  if (index === null || (index.type !== "string" && index.type !== "template_string")) return null
  const { value, whole } = decodeStringLiteral(index)
  return whole && isQnameSegment(value) ? value : null
}

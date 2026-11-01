import { type SyntaxNode, unwrapValue } from "@aburi/core"

// Restated from lang-typescript, which names the registration by this path: the two must agree.
export function isPathLiteral(node: SyntaxNode): boolean {
  const value = unwrapValue(node)
  if (value.type === "string") return true
  if (value.type !== "template_string") return false
  return value.namedChildren.every((child) => child?.type !== "template_substitution")
}

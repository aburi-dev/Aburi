import type { OpaqueAstNode, SymbolCandidate } from "@aburi/types"

export function decideSymbolDrop(symbol: SymbolCandidate<OpaqueAstNode>): string | null {
  if (symbol.decorators.some((d) => d.boundary)) return null

  if (symbol.kind === "interface") return "interface (data model)"
  if (symbol.kind === "type") return "type alias"

  if ((symbol.kind === "function" || symbol.kind === "method") && !hasAnyBody(symbol)) {
    return declaresWithoutBody(symbol) ? null : "empty body"
  }

  if (symbol.derivedBy.includes("re-export")) return "re-export"

  return null
}

function hasAnyBody(symbol: SymbolCandidate<OpaqueAstNode>): boolean {
  if (symbol.bodyNode !== null) return true
  const merged = symbol.mergedDeclarations ?? []
  return merged.some((declaration) => declaration.bodyNode !== null)
}

// An abstract member or a `declare` has no body by definition: the signature is what it declares,
// and what a subclass or a caller is checked against.
function declaresWithoutBody(symbol: SymbolCandidate<OpaqueAstNode>): boolean {
  return symbol.derivedBy.some((token) => BODILESS_DECLARATIONS.has(token))
}

const BODILESS_DECLARATIONS: ReadonlySet<string> = new Set([
  "abstract-declaration",
  "ambient-declaration",
])

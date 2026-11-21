import { representativeSymbol, type SymbolChange } from "@aburi/types"

export type Origin = "authored" | "test" | "generated"

/**
 * A generated test file goes with the generated files: what a program wrote is not read change by
 * change, test code or not.
 */
export function originOf(change: SymbolChange): Origin {
  const symbol = representativeSymbol(change)
  if (symbol.inGeneratedFile === true) return "generated"
  return symbol.inTestFile === true ? "test" : "authored"
}

export function byOrigin(changes: readonly SymbolChange[]): Record<Origin, SymbolChange[]> {
  const groups: Record<Origin, SymbolChange[]> = { authored: [], test: [], generated: [] }
  for (const change of changes) groups[originOf(change)].push(change)
  return groups
}

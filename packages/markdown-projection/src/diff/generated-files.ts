import { representativeSymbol, type SymbolChange } from "@aburi/types"
import { compareStrings, counted, inlineCode } from "../format"
import type { FoldedDependencies } from "./folded-dependencies"

export function inGeneratedFile(change: SymbolChange): boolean {
  return representativeSymbol(change).inGeneratedFile === true
}

export function renderGeneratedFiles(
  changes: readonly SymbolChange[],
  dependencies: FoldedDependencies,
): string[] {
  if (changes.length === 0) return []
  const perFile = new Map<string, number>()
  for (const change of changes) {
    const { file } = representativeSymbol(change).source
    perFile.set(file, (perFile.get(file) ?? 0) + 1)
  }
  const files = [...perFile].sort(([a], [b]) => compareStrings(a, b))
  const symbolChanges = counted(changes.length, "Symbol change", "Symbol changes")
  const edges = dependencies.added.length + dependencies.removed.length
  const held =
    edges === 0
      ? symbolChanges
      : `${symbolChanges} and ${counted(edges, "dependency change", "dependency changes")}`
  const named = files.map(([file, count]) => `${inlineCode(file)} (${count})`).join(", ")
  return [`${held} in ${counted(files.length, "generated file", "generated files")}: ${named}`]
}

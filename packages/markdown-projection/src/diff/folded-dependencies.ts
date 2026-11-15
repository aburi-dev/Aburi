import {
  type Dependency,
  type DependencyEndpoint,
  type DiffResult,
  representativeSymbol,
  type SymbolChange,
} from "@aburi/types"

export interface FoldedDependencies {
  readonly added: readonly Dependency[]
  readonly removed: readonly Dependency[]
}

/**
 * An edge carries no mark, but a call edge that comes or goes moves its caller's calls, so the
 * caller is one of the changes a fold holds, and the edge goes with it.
 */
export function splitDependencies(
  dependencies: DiffResult["dependencies"],
  foldedChanges: readonly SymbolChange[],
  listedFoldedChanges: readonly SymbolChange[],
): { kept: DiffResult["dependencies"]; folded: FoldedDependencies; leftOut: number } {
  const fromFolded = calledFrom(foldedChanges)
  const fromListed = calledFrom(listedFoldedChanges)
  const folded = {
    added: dependencies.added.filter(fromListed),
    removed: dependencies.removed.filter(fromListed),
  }
  const fromFoldedCount = [...dependencies.added, ...dependencies.removed].filter(fromFolded).length
  return {
    kept: {
      ...dependencies,
      added: dependencies.added.filter((d) => !fromFolded(d)),
      removed: dependencies.removed.filter((d) => !fromFolded(d)),
    },
    folded,
    leftOut: fromFoldedCount - folded.added.length - folded.removed.length,
  }
}

function calledFrom(changes: readonly SymbolChange[]): (dependency: Dependency) => boolean {
  const callers = new Set<DependencyEndpoint>()
  for (const change of changes) {
    callers.add(representativeSymbol(change).id)
    if ("before" in change) callers.add(change.before.id)
  }
  return (dependency) => callers.has(dependency.from)
}

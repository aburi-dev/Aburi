import type { Symbol as IRSymbol, SymbolId, SymbolKind } from "@aburi/types"
import { groupBy } from "./collections"

type Language = string
type FilePath = string
type ComponentKey = string
type ByName = ReadonlyMap<string, readonly IRSymbol[]>

/** A class Symbol's id and the name of the class it extends. */
export type Superclass = readonly [classId: SymbolId, superclass: string]

export interface SymbolTable {
  /** Dropped Symbols included: a member a class declares hides its superclass's, kept or not. */
  symbolIds: ReadonlySet<SymbolId>
  keptSymbolIds: ReadonlySet<SymbolId>
  keptById: ReadonlyMap<SymbolId, IRSymbol>
  topLevelByFile: ReadonlyMap<FilePath, ByName>
  memberOwnersByFile: ReadonlyMap<FilePath, ReadonlySet<string>>
  filesByLanguage: ReadonlyMap<Language, ReadonlySet<FilePath>>
  byComponent: ReadonlyMap<Language, ReadonlyMap<ComponentKey, ByName>>
  byWorkspace: ReadonlyMap<Language, ByName>
}

/** `moduleFiles` adds, by language, files the scan read that hold no Symbol, such as a barrel. */
export function buildSymbolTable(
  symbols: readonly IRSymbol[],
  moduleFiles: ReadonlyMap<Language, ReadonlySet<FilePath>> = new Map(),
): SymbolTable {
  const kept = symbols.filter((symbol) => !symbol.dropped)
  const byName = (group: readonly IRSymbol[]) => groupBy(group, (symbol) => symbol.name)
  const keptByLanguage = groupBy(kept, (symbol) => symbol.language)
  const topLevelPerFile = (group: readonly IRSymbol[]) =>
    groupBy(
      group.filter((symbol) => !symbol.name.includes(".")),
      (symbol) => symbol.source.file,
    )
  return {
    symbolIds: new Set(symbols.map((symbol) => symbol.id)),
    keptSymbolIds: new Set(kept.map((symbol) => symbol.id)),
    keptById: new Map(kept.map((symbol) => [symbol.id, symbol])),
    topLevelByFile: mapValues(topLevelPerFile(kept), byName),
    // Dropping a declaration keeps it out of `resolved`, not out of what its name means.
    memberOwnersByFile: mapValues(
      topLevelPerFile(symbols.filter(listsItsMembers)),
      (owners) => new Set(owners.map((symbol) => symbol.name)),
    ),
    filesByLanguage: filesByLanguageOf(symbols, moduleFiles),
    byComponent: mapValues(keptByLanguage, (perLanguage) =>
      mapValues(
        groupBy(perLanguage, (symbol) => componentKeyOf(symbol.component)),
        byName,
      ),
    ),
    byWorkspace: mapValues(keptByLanguage, byName),
  }
}

const MEMBER_OWNER_KINDS: ReadonlySet<SymbolKind> = new Set(["class", "enum", "namespace"])

// `declare` says the value is defined elsewhere, which may declare members this file does not.
function listsItsMembers(symbol: IRSymbol): boolean {
  if (symbol.derivedBy.includes("ambient-declaration")) return false
  return (
    MEMBER_OWNER_KINDS.has(symbol.kind) || symbol.derivedBy.includes("object-literal-initializer")
  )
}

export function componentKeyOf(component: string | null | undefined): ComponentKey {
  return component ?? ""
}

function mapValues<K, V, W>(map: ReadonlyMap<K, V>, transform: (value: V) => W): Map<K, W> {
  return new Map([...map].map(([key, value]) => [key, transform(value)]))
}

function filesByLanguageOf(
  symbols: readonly IRSymbol[],
  moduleFiles: ReadonlyMap<Language, ReadonlySet<FilePath>>,
): Map<Language, ReadonlySet<FilePath>> {
  const files = mapValues(
    groupBy<IRSymbol, Language>(symbols, (symbol) => symbol.language),
    (perLanguage): ReadonlySet<FilePath> =>
      new Set(perLanguage.map((symbol) => symbol.source.file)),
  )
  for (const [language, paths] of moduleFiles) {
    files.set(language, new Set([...(files.get(language) ?? []), ...paths]))
  }
  return files
}

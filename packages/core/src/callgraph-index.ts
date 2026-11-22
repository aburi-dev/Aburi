import {
  EXPORT_CLAUSE_DERIVED_BY_PREFIX,
  type Symbol as IRSymbol,
  type SymbolId,
  type SymbolKind,
} from "@aburi/types"
import { groupBy } from "./collections"

type Language = string
type FilePath = string
type ComponentKey = string
type ByName = ReadonlyMap<string, readonly IRSymbol[]>

export interface SymbolTable {
  /** Every Symbol by id, dropped ones included. */
  allById: ReadonlyMap<SymbolId, IRSymbol>
  keptSymbolIds: ReadonlySet<SymbolId>
  keptById: ReadonlyMap<SymbolId, IRSymbol>
  topLevelByFile: ReadonlyMap<FilePath, ByName>
  memberOwnersByFile: ReadonlyMap<FilePath, ReadonlySet<string>>
  /**
   * By file, then by a name an export clause exports: the top-level declarations it exports under
   * that name, dropped ones included.
   */
  clauseExportsByFile: ReadonlyMap<FilePath, ReadonlyMap<string, readonly string[]>>
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
    allById: new Map(symbols.map((symbol) => [symbol.id, symbol])),
    keptSymbolIds: new Set(kept.map((symbol) => symbol.id)),
    keptById: new Map(kept.map((symbol) => [symbol.id, symbol])),
    topLevelByFile: mapValues(topLevelPerFile(kept), byName),
    // Dropping a declaration keeps it out of `resolved`, not out of what its name means.
    memberOwnersByFile: mapValues(
      topLevelPerFile(symbols.filter(listsItsMembers)),
      (owners) => new Set(owners.map((symbol) => symbol.name)),
    ),
    clauseExportsByFile: mapValues(topLevelPerFile(symbols), clauseExportsOf),
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

function clauseExportsOf(symbols: readonly IRSymbol[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const symbol of symbols) {
    for (const token of symbol.derivedBy) {
      if (!token.startsWith(EXPORT_CLAUSE_DERIVED_BY_PREFIX)) continue
      const exported = token.slice(EXPORT_CLAUSE_DERIVED_BY_PREFIX.length)
      const names = out.get(exported)
      if (names === undefined) out.set(exported, [symbol.name])
      else names.push(symbol.name)
    }
  }
  return out
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

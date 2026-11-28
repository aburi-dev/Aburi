import {
  AMBIENT_DECLARATION_DERIVED_BY,
  type Symbol as IRSymbol,
  type SymbolId,
  type SymbolKind,
} from "@aburi/types"
import { groupBy } from "./collections"
import { exportNames } from "./export-names"

type Language = string
type FilePath = string
type ComponentKey = string
type ByName = ReadonlyMap<string, readonly IRSymbol[]>

export interface SymbolTable {
  /** Every Symbol by id, dropped ones included. */
  allById: ReadonlyMap<SymbolId, IRSymbol>
  /**
   * What a call may resolve to, as `keptById` and the maps by name hold it too: the kept Symbols,
   * less a function or method written under `declare`.
   */
  keptSymbolIds: ReadonlySet<SymbolId>
  keptById: ReadonlyMap<SymbolId, IRSymbol>
  topLevelByFile: ReadonlyMap<FilePath, ByName>
  memberOwnersByFile: ReadonlyMap<FilePath, ReadonlySet<string>>
  /**
   * By file, then by each name an export token gives — a declaration's own, an export clause's,
   * `default` and `export=` — the top-level declarations it exports under that name, dropped ones
   * included.
   */
  exportsByFile: ReadonlyMap<FilePath, ReadonlyMap<string, readonly string[]>>
  filesByLanguage: ReadonlyMap<Language, ReadonlySet<FilePath>>
  byComponent: ReadonlyMap<Language, ReadonlyMap<ComponentKey, ByName>>
  byWorkspace: ReadonlyMap<Language, ByName>
}

/** `moduleFiles` adds, by language, files the scan read that hold no Symbol, such as a barrel. */
export function buildSymbolTable(
  symbols: readonly IRSymbol[],
  moduleFiles: ReadonlyMap<Language, ReadonlySet<FilePath>> = new Map(),
): SymbolTable {
  const resolvable = symbols.filter(isResolvable)
  const byName = (group: readonly IRSymbol[]) => groupBy(group, (symbol) => symbol.name)
  const keptByLanguage = groupBy(resolvable, (symbol) => symbol.language)
  const topLevelPerFile = (group: readonly IRSymbol[]) =>
    groupBy(
      group.filter((symbol) => !symbol.name.includes(".")),
      (symbol) => symbol.source.file,
    )
  return {
    allById: new Map(symbols.map((symbol) => [symbol.id, symbol])),
    keptSymbolIds: new Set(resolvable.map((symbol) => symbol.id)),
    keptById: new Map(resolvable.map((symbol) => [symbol.id, symbol])),
    topLevelByFile: mapValues(topLevelPerFile(resolvable), byName),
    // Dropping a declaration keeps it out of `resolved`, not out of what its name means.
    memberOwnersByFile: mapValues(
      topLevelPerFile(symbols.filter(listsItsMembers)),
      (owners) => new Set(owners.map((symbol) => symbol.name)),
    ),
    // What a module exports is what it writes, whatever a drop rule removed.
    exportsByFile: mapValues(topLevelPerFile(symbols), clauseExportsOf),
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

// A function or method written under `declare` is kept for the signature it declares, but `declare`
// says the value is defined elsewhere, so the resolver reads it as it reads a dropped Symbol.
function isResolvable(symbol: IRSymbol): boolean {
  if (symbol.dropped) return false
  return !(
    CALLABLE_KINDS.has(symbol.kind) && symbol.derivedBy.includes(AMBIENT_DECLARATION_DERIVED_BY)
  )
}

const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(["function", "method"])

const MEMBER_OWNER_KINDS: ReadonlySet<SymbolKind> = new Set(["class", "enum", "namespace"])

// `declare` says the value is defined elsewhere, which may declare members this file does not.
function listsItsMembers(symbol: IRSymbol): boolean {
  if (symbol.derivedBy.includes(AMBIENT_DECLARATION_DERIVED_BY)) return false
  return (
    MEMBER_OWNER_KINDS.has(symbol.kind) || symbol.derivedBy.includes("object-literal-initializer")
  )
}

// Each export is read as the clause that would write it: `export function f` as `export { f }`,
// `export default f` as `export { f as default }`, and `export = f` as TypeScript's `export=`.
function clauseExportsOf(symbols: readonly IRSymbol[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const symbol of symbols) {
    for (const name of exportNames(symbol)) {
      const names = out.get(name)
      if (names === undefined) out.set(name, [symbol.name])
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

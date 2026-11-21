import {
  representativeSymbol,
  SYMBOL_CHANGE_STATUSES,
  type SymbolChange,
  type SymbolChangeStatus,
} from "@aburi/types"
import { compareStrings, counted, inlineCode } from "../format"
import type { FoldedDependencies } from "./folded-dependencies"

const GLYPHS: Readonly<Record<SymbolChangeStatus, string>> = {
  added: "+",
  removed: "-",
  changed: "~",
  moved: "↔",
  "moved+changed": "⤴",
  "dropped-toggled": "💧",
  unknown: "?",
}

interface FileChanges {
  readonly compared: Map<SymbolChangeStatus, number>
  /** By why the file was not compared, which is what a reviewer acts on. */
  readonly skipped: Map<string, number>
}

export function renderGeneratedFiles(
  changes: readonly SymbolChange[],
  dependencies: FoldedDependencies,
): string[] {
  if (changes.length === 0) return []
  const perFile = new Map<string, FileChanges>()
  for (const change of changes) {
    const { file } = representativeSymbol(change).source
    let tally = perFile.get(file)
    if (tally === undefined) {
      tally = { compared: new Map(), skipped: new Map() }
      perFile.set(file, tally)
    }
    if (change.status === "unknown") {
      bump(tally.skipped, `skipped at ${change.absentFrom}: ${change.reason}`)
    } else {
      bump(tally.compared, change.status)
    }
  }
  const files = [...perFile].sort(([a], [b]) => compareStrings(a, b))
  const symbolChanges = counted(changes.length, "Symbol change", "Symbol changes")
  const edges = dependencies.added.length + dependencies.removed.length
  const held =
    edges === 0
      ? symbolChanges
      : `${symbolChanges} and ${counted(edges, "dependency change", "dependency changes")}`
  const named = files.map(([file, tally]) => `${inlineCode(file)} (${counts(tally)})`).join(", ")
  return [`${held} in ${counted(files.length, "generated file", "generated files")}: ${named}`]
}

function counts({ compared, skipped }: FileChanges): string {
  const byStatus = SYMBOL_CHANGE_STATUSES.flatMap((status) => {
    const count = compared.get(status)
    return count === undefined ? [] : [`${GLYPHS[status]}${count}`]
  })
  const unknown = [...skipped].map(([why, count]) => `${GLYPHS.unknown}${count} ${why}`)
  return [...(byStatus.length === 0 ? [] : [byStatus.join(" ")]), ...unknown].join(", ")
}

function bump<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

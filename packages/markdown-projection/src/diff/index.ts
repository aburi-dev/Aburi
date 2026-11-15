import {
  type DiffResult,
  isSymbolChangeStatus,
  representativeSymbol,
  SYMBOL_CHANGE_STATUSES,
  type SymbolChange,
  type SymbolChangeStatus,
} from "@aburi/types"
import { counted, inlineCode } from "../format"
import { renderComponentChanges } from "./component-changes"
import { renderDependencyChanges } from "./dependency-changes"
import {
  renderAdded,
  renderChangedList,
  renderDroppedToggled,
  renderMoved,
  renderMovedChanged,
  renderNotCompared,
  renderRemoved,
  renderSyntaxOnly,
  renderUnknown,
} from "./entries"
import { splitDependencies } from "./folded-dependencies"
import { inGeneratedFile, renderGeneratedFiles } from "./generated-files"
import {
  indexChanged,
  indexConfidence,
  indexMoved,
  indexRemoved,
  indexSymbols,
  indexUnknown,
} from "./names-only"
import { partition } from "./partition"
import { assemble, foldedSection, plainSection, type Section } from "./size-cap"
import { renderSliceView } from "./slice-view"
import { inTestFile, renderTestFiles } from "./test-files"

export interface ProjectDiffOptions {
  readonly maxBytes?: number
  readonly fullReportLocation?: string
  /** The statuses whose Symbol changes the report lists; absent, every one. */
  readonly statuses?: readonly SymbolChangeStatus[]
}

export function projectDiff(diff: DiffResult, options: ProjectDiffOptions = {}): string {
  const { maxBytes, fullReportLocation } = options
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes <= 0)) {
    throw new RangeError(
      `projectDiff: maxBytes must be a positive integer (got ${String(maxBytes)}).`,
    )
  }
  if (fullReportLocation !== undefined && /[\r\n]/.test(fullReportLocation)) {
    throw new RangeError(
      "projectDiff: fullReportLocation must not contain a line break; it is set inside a one-line note.",
    )
  }
  const listed = listedChanges(diff.symbols, options.statuses)
  const everyGeneratedChange = diff.symbols.filter(inGeneratedFile)
  const generatedChanges = listed.filter(inGeneratedFile)
  const everyTestChange = diff.symbols.filter(inTestCode)
  const testChanges = listed.filter(inTestCode)
  const fromGenerated = splitDependencies(diff.dependencies, everyGeneratedChange, generatedChanges)
  const fromTests = splitDependencies(fromGenerated.kept, everyTestChange, testChanges)
  const heading = [
    `# Aburi diff: ${titleRef(diff.base.ref)}..${titleRef(diff.head.ref)}`,
    "",
    `**Summary**: ${summaryLine(diff, everyTestChange.length, everyGeneratedChange.length)}`,
    "",
    ...filterNote(options.statuses, diff.symbols.length - listed.length, {
      tests: fromTests.leftOut,
      generated: fromGenerated.leftOut,
    }),
  ]
  const authored = listed.filter((change) => !inTestFile(change) && !inGeneratedFile(change))
  const buckets = partition(authored)
  const shown = new Set(authored)
  const hiddenIds = new Set(
    diff.symbols
      .filter((change) => !shown.has(change))
      .map((change) => representativeSymbol(change).id),
  )
  // A Slice with no members, or with one no change names, is left for the Slice View to refuse.
  const slices = diff.slices.filter(
    ({ members }) => members.length === 0 || members.some((id) => !hiddenIds.has(id)),
  )
  const sections = [
    plainSection(
      "## ⚠ API changes",
      renderChangedList(buckets.apiChanged),
      indexChanged(buckets.apiChanged),
    ),
    plainSection(
      "## 🔧 Logic changes",
      renderChangedList(buckets.logicOnly),
      indexChanged(buckets.logicOnly),
    ),
    plainSection("## 🧵 Slice View", renderSliceView(slices, diff.symbols)),
    plainSection("## ➕ Added", renderAdded(buckets.added), indexSymbols(buckets.added)),
    plainSection("## ➖ Removed", renderRemoved(buckets.removed), indexRemoved(buckets.removed)),
    plainSection("## ❔ Unknown", renderUnknown(buckets.unknown), indexUnknown(buckets.unknown)),
    plainSection("## 🚫 Not compared", renderNotCompared(diff.notCompared ?? [])),
    plainSection(
      "## 🔀 Moved + Changed",
      renderMovedChanged(buckets.movedChanged),
      indexMoved(buckets.movedChanged),
    ),
    foldedSection(
      "## 🔀 Moved",
      renderMoved(buckets.moved),
      `${buckets.moved.length} moved (no semantic change)`,
    ),
    plainSection("## 🧱 Component changes", renderComponentChanges(diff)),
    plainSection("## 🔗 Dependency changes", renderDependencyChanges(fromTests.kept)),
    foldedSection(
      "## 💧 Dropped changes",
      renderDroppedToggled(buckets.droppedToggled),
      counted(buckets.droppedToggled.length, "entry", "entries"),
    ),
    plainSection(
      "## 🎚 Confidence changes",
      renderChangedList(buckets.confidenceOnly),
      indexConfidence(buckets.confidenceOnly),
    ),
    foldedSection(
      "## 🎨 Syntax-only changes",
      renderSyntaxOnly(buckets.syntaxOnly),
      `${counted(buckets.syntaxOnly.length, "symbol", "symbols")} (implementation refactor only, no semantic change)`,
    ),
    foldedSection(
      "## 🧪 Test files",
      renderTestFiles(testChanges, fromTests.folded),
      counted(testChanges.length, "symbol in a test file", "symbols in test files"),
    ),
    plainSection(
      "## ⚙ Generated files",
      renderGeneratedFiles(generatedChanges, fromGenerated.folded),
    ),
  ].filter((entry): entry is Section => entry !== null)

  return assemble(heading, sections, maxBytes, fullReportLocation)
}

/** A generated test file is generated code first: its changes are not read one by one either. */
function inTestCode(change: SymbolChange): boolean {
  return inTestFile(change) && !inGeneratedFile(change)
}

function listedChanges(
  symbols: readonly SymbolChange[],
  statuses: readonly SymbolChangeStatus[] | undefined,
): readonly SymbolChange[] {
  if (statuses === undefined) return symbols
  if (statuses.length === 0) {
    throw new RangeError(
      "projectDiff: statuses must name at least one status; a report filtered to nothing reads as a diff that found nothing.",
    )
  }
  const unknown = statuses.filter((status) => !isSymbolChangeStatus(status))
  if (unknown.length > 0) {
    throw new RangeError(
      `projectDiff: ${unknown.map((status) => JSON.stringify(status)).join(", ")} is no Symbol change status (expected ${SYMBOL_CHANGE_STATUSES.join(", ")}).`,
    )
  }
  const kept = new Set(statuses)
  return symbols.filter((change) => kept.has(change.status))
}

function filterNote(
  statuses: readonly SymbolChangeStatus[] | undefined,
  leftOut: number,
  edgesLeftOut: { readonly tests: number; readonly generated: number },
): string[] {
  if (statuses === undefined || leftOut === 0) return []
  const names = SYMBOL_CHANGE_STATUSES.filter((status) => statuses.includes(status)).map(inlineCode)
  const listed =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
  const changes = counted(leftOut, "other Symbol change", "other Symbol changes")
  const edges = edgesLeftOut.tests + edgesLeftOut.generated
  const origin = [
    ...(edgesLeftOut.tests === 0 ? [] : ["test code"]),
    ...(edgesLeftOut.generated === 0 ? [] : ["generated files"]),
  ].join(" and ")
  const omitted =
    edges === 0
      ? `${changes} ${leftOut === 1 ? "is" : "are"} left out of this report; the Summary counts ${leftOut === 1 ? "it" : "them"}.`
      : `${changes} and ${counted(edges, "dependency change", "dependency changes")} from ${origin} are left out of this report; the Summary counts the Symbol ${leftOut === 1 ? "change" : "changes"}.`
  return [`> ℹ **Only ${listed} changes are listed.** ${omitted}`, ""]
}

export function projectDiffSummaryLine(diff: DiffResult): string {
  const summary = diff.summary
  return withUnknown(
    `+${summary.added} -${summary.removed} ~${summary.changed} ↔${summary.moved} ⤴${summary.movedChanged}`,
    diff,
  )
}

/** Hex admits no Markdown, and GitHub links a bare commit SHA, which it does not inside a span. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/

function titleRef(ref: string): string {
  return COMMIT_SHA.test(ref) ? ref : inlineCode(ref)
}

function summaryLine(diff: DiffResult, inTests: number, inGenerated: number): string {
  const summary = diff.summary
  const duplicates = summary.removedDuplicates ?? 0
  const removed =
    duplicates === 0 ? "removed" : `removed (${counted(duplicates, "duplicate", "duplicates")})`
  const line = withUnknown(
    `+${summary.added} added · -${summary.removed} ${removed} · ~${summary.changed} changed · ${summary.moved} moved · ${summary.movedChanged} moved+changed`,
    diff,
  )
  const tests = inTests === 0 ? "" : ` · ${inTests} in test files`
  const generated = inGenerated === 0 ? "" : ` · ${inGenerated} in generated files`
  return `${line}${tests}${generated}`
}

function withUnknown(line: string, diff: DiffResult): string {
  const unknown = diff.summary.unknown ?? 0
  return unknown === 0 ? line : `${line} · ?${unknown} unknown`
}

import type {
  CallResolutionStats,
  Symbol as IRSymbol,
  UnresolvedCallDiagnostic,
} from "@aburi/types"
import { buildCallResolutionStats } from "../callgraph-diagnostics"
import type { ReadFile } from "../lsp"

const GENERATED_TAG = /@generated\b/
const FILE_IS_GENERATED =
  /\b(?:file|code)\s+(?:is|was|has\s+been)\s+(?:auto-?|auto\s+|automatically\s+)?generated\b/i
const GENERATED = /\bgenerated\b/i
const DO_NOT_EDIT = /\b(?:do\s+not|don['’]t)\s+(?:edit|modify)\b/i

export function opensAsGenerated(content: string): boolean {
  const header = openingComments(content)
  return (
    GENERATED_TAG.test(header) ||
    FILE_IS_GENERATED.test(header) ||
    (GENERATED.test(header) && DO_NOT_EDIT.test(header))
  )
}

function openingComments(content: string): string {
  const comments: string[] = []
  let at = 0
  for (;;) {
    while (at < content.length && isWhitespace(content.charCodeAt(at))) at++
    let end: number
    if (content.startsWith("//", at) || content.startsWith("#", at)) {
      const newline = content.indexOf("\n", at)
      end = newline < 0 ? content.length : newline
    } else if (content.startsWith("/*", at)) {
      const close = content.indexOf("*/", at + 2)
      end = close < 0 ? content.length : close + 2
    } else {
      return comments.join("\n")
    }
    comments.push(content.slice(at, end))
    at = end
  }
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0xfeff
}

export function markGeneratedFiles(
  symbols: readonly IRSymbol[],
  contents: ReadonlyMap<string, ReadFile>,
): IRSymbol[] {
  const generated = new Set<string>()
  for (const [file, read] of contents) if (opensAsGenerated(read.content)) generated.add(file)
  if (generated.size === 0) return [...symbols]
  return symbols.map((symbol) =>
    generated.has(symbol.source.file) ? { ...symbol, inGeneratedFile: true } : symbol,
  )
}

export function withGeneratedCallCensus(
  stats: CallResolutionStats,
  symbols: readonly IRSymbol[],
  diagnostics: readonly UnresolvedCallDiagnostic[],
): CallResolutionStats {
  const marked = new Set<string>()
  let totalCalls = 0
  let resolvedCalls = 0
  for (const symbol of symbols) {
    if (symbol.inGeneratedFile !== true) continue
    marked.add(symbol.id)
    totalCalls += symbol.calls.length
    for (const call of symbol.calls) if (call.resolved !== null) resolvedCalls++
  }
  if (marked.size === 0) return stats
  const ofMarked = diagnostics.filter((diagnostic) => marked.has(diagnostic.symbolId))
  return { ...stats, generated: buildCallResolutionStats(totalCalls, resolvedCalls, ofMarked) }
}

import type {
  CallResolutionStats,
  Symbol as IRSymbol,
  UnresolvedCallDiagnostic,
} from "@aburi/types"
import { buildCallResolutionStats } from "../callgraph-diagnostics"
import type { ReadFile } from "../lsp"

const GENERATED = String.raw`(?:auto-?|auto\s+|automatically\s+)?generated`
const GENERATED_TAG = /@generated(?![\w/-])/
const SAYS_IT_IS_GENERATED = new RegExp(
  String.raw`\b(?:(?:this|the\s+following)\s+(?:file|code)\s+(?:is|was|has\s+been)\s+${GENERATED}|this\s+is\s+an?\s+${GENERATED}\s+(?:file|code))\b`,
  "i",
)
const GENERATED_HEADER_WORD = new RegExp(
  String.raw`^${GENERATED}\b|\b${GENERATED}\s+(?:by|file|code)\b`,
  "im",
)
const DO_NOT_EDIT = /\b(?:do\s+not|don['’]t)\s+(?:edit|modify)\b/i
const LINE_PREFIX = /^[\s*/#!]+/
const LINE_BREAK = /\r\n?|[\n\u2028\u2029]/

export function opensAsGenerated(content: string): boolean {
  return openingComments(content).some(
    (comment) =>
      GENERATED_TAG.test(comment) ||
      SAYS_IT_IS_GENERATED.test(comment) ||
      (GENERATED_HEADER_WORD.test(comment) && DO_NOT_EDIT.test(comment)),
  )
}

/** Each comment's lines without the `//`, `#` or ` * ` they open with, so a phrase can span them. */
function openingComments(content: string): string[] {
  const comments: string[] = []
  let at = 0
  for (;;) {
    at = skipWhitespace(content, at, isWhitespace)
    if (opensLineComment(content, at)) {
      const lines: string[] = []
      // A run of line comments on consecutive lines is one comment, as a block's lines are.
      do {
        const end = lineEnd(content, at)
        lines.push(content.slice(at, end))
        at = skipWhitespace(content, afterLineBreak(content, end), isSpaceWithinLine)
      } while (opensLineComment(content, at))
      comments.push(commentText(lines))
    } else if (content.startsWith("/*", at)) {
      const close = content.indexOf("*/", at + 2)
      const end = close < 0 ? content.length : close
      comments.push(commentText(content.slice(at + 2, end).split(LINE_BREAK)))
      at = close < 0 ? content.length : close + 2
    } else {
      return comments
    }
  }
}

function commentText(lines: readonly string[]): string {
  return lines.map((line) => line.replace(LINE_PREFIX, "")).join("\n")
}

function opensLineComment(content: string, at: number): boolean {
  return content.startsWith("//", at) || content.startsWith("#", at)
}

function lineEnd(content: string, at: number): number {
  let end = at
  while (end < content.length && !isLineTerminator(content.charCodeAt(end))) end++
  return end
}

function afterLineBreak(content: string, end: number): number {
  if (content.startsWith("\r\n", end)) return end + 2
  return Math.min(end + 1, content.length)
}

function skipWhitespace(content: string, at: number, skips: (code: number) => boolean): number {
  let next = at
  while (next < content.length && skips(content.charCodeAt(next))) next++
  return next
}

function isWhitespace(code: number): boolean {
  return isLineTerminator(code) || isSpaceWithinLine(code)
}

function isSpaceWithinLine(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0xa0 ||
    code === 0xfeff
  )
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029
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

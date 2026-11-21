import type {
  CallCensus,
  DeclinedCall,
  IR,
  Symbol as IRSymbol,
  UnresolvedCallBuckets,
} from "@aburi/types"
import type { IntegrityViolation } from "./errors"

export function checkSkippedFilesCensus(ir: IR, out: IntegrityViolation[]): void {
  const unparsed = ir.stats.totalFiles - ir.stats.parsedFiles
  if (unparsed < 0) {
    out.push({
      invariant: 21,
      subject: "stats.parsedFiles",
      message: `stats.parsedFiles is ${ir.stats.parsedFiles} of ${ir.stats.totalFiles} total file(s); a scan cannot parse more files than it found`,
    })
  }

  const skippedFiles = ir.stats.skippedFiles
  if (skippedFiles === undefined) return

  if (skippedFiles.length !== unparsed) {
    out.push({
      invariant: 21,
      subject: "stats.skippedFiles",
      message: `stats.skippedFiles names ${skippedFiles.length} file(s) but totalFiles - parsedFiles is ${unparsed}`,
    })
  }

  const seen = new Set<string>()
  for (const file of skippedFiles) {
    if (seen.has(file.path)) {
      out.push({
        invariant: 21,
        subject: "stats.skippedFiles",
        message: `stats.skippedFiles names "${file.path}" more than once; one file is skipped for one reason`,
      })
      continue
    }
    seen.add(file.path)
  }
}

export function checkCallResolutionStatsCensus(ir: IR, out: IntegrityViolation[]): void {
  const stats = ir.stats.callResolution
  const generated = ir.symbols.filter((symbol) => symbol.inGeneratedFile === true)
  if (stats === undefined) {
    if (generated.length > 0) {
      out.push({
        invariant: 15,
        subject: "stats.callResolution",
        message: `${generated.length} Symbol(s) carry inGeneratedFile but the Document has no stats.callResolution; the scan that marks a file writes the census beside it`,
      })
    }
    return
  }
  checkCensus("stats.callResolution", stats, countCalls(ir.symbols), out)

  if (stats.generated === undefined) {
    if (generated.length > 0) {
      out.push({
        invariant: 15,
        subject: "stats.callResolution.generated",
        message: `${generated.length} Symbol(s) carry inGeneratedFile but stats.callResolution has no generated census, so their calls count as authored code's`,
      })
    }
    return
  }
  if (generated.length === 0) {
    out.push({
      invariant: 15,
      subject: "stats.callResolution.generated",
      message: "stats.callResolution.generated is present but no Symbol carries inGeneratedFile",
    })
  }
  checkCensus("stats.callResolution.generated", stats.generated, countCalls(generated), out)
  for (const bucket of Object.keys(stats.unresolved) as (keyof UnresolvedCallBuckets)[]) {
    if (stats.generated.unresolved[bucket] > stats.unresolved[bucket]) {
      out.push({
        invariant: 15,
        subject: "stats.callResolution.generated.unresolved",
        message: `the generated census counts ${stats.generated.unresolved[bucket]} ${bucket} call(s) of the ${stats.unresolved[bucket]} the whole counts`,
      })
    }
  }
}

interface CallCount {
  totalCalls: number
  resolvedCalls: number
}

function countCalls(symbols: readonly IRSymbol[]): CallCount {
  let totalCalls = 0
  let resolvedCalls = 0
  for (const symbol of symbols) {
    totalCalls += symbol.calls.length
    for (const call of symbol.calls) if (call.resolved !== null) resolvedCalls++
  }
  return { totalCalls, resolvedCalls }
}

function checkCensus(
  subject: string,
  census: CallCensus,
  carried: CallCount,
  out: IntegrityViolation[],
): void {
  if (census.totalCalls !== carried.totalCalls) {
    out.push({
      invariant: 15,
      subject: `${subject}.totalCalls`,
      message: `${subject}.totalCalls is ${census.totalCalls} but symbols[] carry ${carried.totalCalls} call sites`,
    })
  }
  if (census.resolvedCalls !== carried.resolvedCalls) {
    out.push({
      invariant: 15,
      subject: `${subject}.resolvedCalls`,
      message: `${subject}.resolvedCalls is ${census.resolvedCalls} but symbols[] carry ${carried.resolvedCalls} resolved calls`,
    })
  }
  const { unresolved } = census
  const bucketed =
    unresolved.localScope +
    unresolved.external +
    unresolved.dynamic +
    unresolved.ambiguous +
    unresolved.noMatch
  if (bucketed !== census.totalCalls - census.resolvedCalls) {
    out.push({
      invariant: 15,
      subject: `${subject}.unresolved`,
      message: `bucket counts sum to ${bucketed} but totalCalls - resolvedCalls is ${census.totalCalls - census.resolvedCalls}`,
    })
  }
}

export function checkDeclinedCallsStayCalls(ir: IR, out: IntegrityViolation[]): void {
  const declined = ir.stats.declinedCalls
  if (declined === undefined) return
  const symbols = new Map<string, IRSymbol>(ir.symbols.map((symbol) => [symbol.id, symbol]))
  for (const entry of declined) {
    const message = declinedCallFault(entry, symbols.get(entry.symbolId))
    if (message !== null) out.push({ invariant: 22, subject: "stats.declinedCalls", message })
  }
}

function declinedCallFault(entry: DeclinedCall, owner: IRSymbol | undefined): string | null {
  const where = `${entry.target} (L${entry.line}) [${entry.plugin}]`
  if (owner === undefined)
    return `${where} names "${entry.symbolId}", which is not a Symbol in symbols[]`
  if (owner.dropped) {
    return `${where} names the dropped Symbol "${entry.symbolId}", which carries no calls`
  }
  if (owner.calls.some((call) => call.line === entry.line && call.target === entry.target)) {
    return null
  }
  return `${where} is not among the calls[] of "${entry.symbolId}"; a call no plugin classified stays a call`
}

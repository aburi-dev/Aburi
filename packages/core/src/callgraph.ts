import type {
  CallResolutionStats,
  Confidence,
  ImportEdge,
  IR,
  Symbol as IRSymbol,
  SymbolId,
  UnresolvedCallDiagnostic,
} from "@aburi/types"
import {
  CALL_SITE_KEY_SEPARATOR,
  type ClassHeritages,
  type DeclaredReceiverTypes,
  makeCallSiteKey,
  makeSymbolCallKey,
  type ReceiverCalls,
  type ReturnSources,
  type ValueTypes,
} from "./call-site"
import {
  buildCallResolutionStats,
  classifyUnresolved,
  compareDiagnostic,
  type WorkspaceNames,
  workspaceNamesOf,
} from "./callgraph-diagnostics"
import { buildSymbolTable } from "./callgraph-index"
import { CallResolver } from "./callgraph-outcomes"
import { mappedTargetOf, type ResolutionRun } from "./callgraph-scopes"
import { DEFAULT_EXTENSIONS } from "./callgraph-specifier"
import { CoreError } from "./errors"
import type { ReceiverHint } from "./lsp/enrich"
import { emptyHintUsage, type LspHintUsage } from "./lsp/stats"
import { compareCodeUnit } from "./order"

export interface CallEdge {
  from: SymbolId
  to: SymbolId
  via: "call"
  confidence: Confidence
  line: number
}

export interface ResolveCallGraphInput {
  symbols: readonly IRSymbol[]
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>
  fileExtensions?: readonly string[]
  receiverHints?: ReadonlyMap<string, ReceiverHint>
  implementerHints?: ReadonlyMap<SymbolId, readonly SymbolId[]>
  dynamicCallSites?: ReadonlySet<string>
  /** By `makeSymbolCallKey`: the named type each call's receiver is declared with. */
  declaredReceiverTypes?: DeclaredReceiverTypes
  /** By `makeSymbolCallKey`: each call whose receiver's leading name an import of its file binds. */
  importedReceivers?: ReadonlySet<string>
  /** By `makeSymbolCallKey`: each call whose leading name no scope around it declares. */
  unboundHeads?: ReadonlySet<string>
  /** By `makeSymbolCallKey`: each call whose leading name a scope nearer it than the module declares. */
  localHeads?: ReadonlySet<string>
  classHeritages?: ClassHeritages
  /** By variable Symbol id: the named type its module declares its value with. */
  valueTypes?: ValueTypes
  /** By function or variable Symbol id: what a call of it gives back, as its declaration says. */
  returnSources?: ReturnSources
  /** By `makeSymbolCallKey`: the call whose result each call's receiver is. */
  receiverCalls?: ReceiverCalls
  /**
   * By importing file, then by bare specifier: the workspace-relative paths the language's import
   * resolver maps the specifier to, probed in order as a relative specifier's path is.
   */
  specifierPaths?: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>
  /**
   * The names the workspace's packages are published under: a named import from one that reaches
   * no file the scan read goes on to component scope, and one from any other package ends there.
   */
  workspacePackageNames?: ReadonlySet<string>
  /**
   * By language: every file the scan read, Symbols or not, so that a specifier naming a barrel
   * that only re-exports still reaches it.
   */
  moduleFiles?: ReadonlyMap<string, ReadonlySet<string>>
}

export interface ResolveCallGraphResult {
  symbols: IRSymbol[]
  edges: CallEdge[]
  stats: CallResolutionStats
  diagnostics: UnresolvedCallDiagnostic[]
  lspHintUsage: Readonly<LspHintUsage>
}

export function resolveCallGraph(input: ResolveCallGraphInput): ResolveCallGraphResult {
  const receiverHints = input.receiverHints ?? EMPTY_RECEIVER_HINTS
  assertReceiverHintKeys(receiverHints)
  const dynamicCallSites = input.dynamicCallSites ?? EMPTY_CALL_SITE_KEYS
  const declaredReceiverTypes = input.declaredReceiverTypes ?? EMPTY_DECLARED_RECEIVER_TYPES
  const importedReceivers = input.importedReceivers ?? EMPTY_CALL_SITE_KEYS
  const unboundHeads = input.unboundHeads ?? EMPTY_CALL_SITE_KEYS
  let names: WorkspaceNames | null = null
  const workspaceNames = (): WorkspaceNames => {
    names ??= workspaceNamesOf(input.symbols, input.importsByFile)
    return names
  }
  const run: ResolutionRun = {
    table: buildSymbolTable(input.symbols, input.moduleFiles),
    classHeritages: input.classHeritages ?? new Map(),
    valueTypes: input.valueTypes ?? new Map(),
    extensions: input.fileExtensions ?? DEFAULT_EXTENSIONS,
    relativeTargets: new Map(),
    specifierPaths: input.specifierPaths ?? new Map(),
    workspacePackageNames: input.workspacePackageNames ?? EMPTY_NAMES,
    mappedTargets: new Map(),
    importsByFile: input.importsByFile,
    exportAnswers: new Map(),
  }

  const resolver = new CallResolver({
    run,
    symbols: input.symbols,
    receiverHints,
    declaredReceiverTypes,
    importedReceivers,
    localHeads: input.localHeads ?? EMPTY_CALL_SITE_KEYS,
    receiverCalls: input.receiverCalls ?? EMPTY_RECEIVER_CALLS,
    returnSources: input.returnSources ?? EMPTY_RETURN_SOURCES,
  })

  const nextSymbols: IRSymbol[] = []
  const edges: CallEdge[] = []
  const diagnostics: UnresolvedCallDiagnostic[] = []
  const lspHintUsage = emptyHintUsage()
  let totalCalls = 0
  let resolvedCalls = 0

  for (const symbol of input.symbols) {
    if (symbol.calls.length === 0) {
      nextSymbols.push(symbol)
      continue
    }
    totalCalls += symbol.calls.length
    const imports = input.importsByFile.get(symbol.source.file) ?? []
    const updatedCalls = symbol.calls.map((call) => {
      if (call.resolved !== null) {
        resolvedCalls++
        return call
      }
      const { hit, trace, hinted } = resolver.outcomeOf(symbol, call)
      if (hinted?.outcome === "rejected") lspHintUsage[hinted.reason] += 1
      if (hinted?.outcome === "hit") lspHintUsage.consumed += 1
      if (hit === null) {
        const callSiteKey = makeCallSiteKey(symbol.source.file, call.line, call.target)
        diagnostics.push(
          classifyUnresolved({
            caller: symbol,
            target: call.target,
            line: call.line,
            imports,
            trace,
            dynamicReceiver: dynamicCallSites.has(callSiteKey),
            reachesWorkspace: (specifier) =>
              mappedTargetOf(run, symbol.language, symbol.source.file, specifier) !== null,
            unboundHead: unboundHeads.has(makeSymbolCallKey(symbol.id, call.line, call.target)),
            names: workspaceNames(),
          }),
        )
        return call
      }
      resolvedCalls++
      edges.push({
        from: symbol.id,
        to: hit.id,
        via: "call",
        confidence: hit.confidence,
        line: call.line,
      })
      return { target: call.target, line: call.line, resolved: hit.id }
    })
    nextSymbols.push({ ...symbol, calls: updatedCalls })
  }

  edges.sort(compareCallEdge)
  diagnostics.sort(compareDiagnostic)
  return {
    symbols: nextSymbols,
    edges,
    stats: buildCallResolutionStats(totalCalls, resolvedCalls, diagnostics),
    diagnostics,
    lspHintUsage,
  }
}

const EMPTY_CALL_SITE_KEYS: ReadonlySet<string> = new Set()
const EMPTY_NAMES: ReadonlySet<string> = new Set()
const EMPTY_RECEIVER_HINTS: ReadonlyMap<string, ReceiverHint> = new Map()
const EMPTY_DECLARED_RECEIVER_TYPES: DeclaredReceiverTypes = new Map()
const EMPTY_RECEIVER_CALLS: ReceiverCalls = new Map()
const EMPTY_RETURN_SOURCES: ReturnSources = new Map()

function assertReceiverHintKeys(hints: ReadonlyMap<string, ReceiverHint>): void {
  for (const key of hints.keys()) {
    if (key.includes(CALL_SITE_KEY_SEPARATOR)) continue
    throw new CoreError(
      `resolveCallGraph: receiverHints key ${JSON.stringify(key)} was not built by makeCallSiteKey(file, line, target)`,
      { code: "receiver-hint-key-malformed", value: key },
    )
  }
}

export function reconstructCallEdgesFromIR(ir: IR): CallEdge[] {
  const edges: CallEdge[] = []
  for (const symbol of ir.symbols) {
    for (const call of symbol.calls) {
      if (call.resolved === null) continue
      edges.push({
        from: symbol.id,
        to: call.resolved,
        via: "call",
        confidence: symbol.confidence,
        line: call.line,
      })
    }
  }
  return edges.sort(compareCallEdge)
}

function compareCallEdge(a: CallEdge, b: CallEdge): number {
  return compareCodeUnit(a.from, b.from) || compareCodeUnit(a.to, b.to) || a.line - b.line
}

import type { Call, Symbol as IRSymbol, SymbolId } from "@aburi/types"
import {
  type DeclaredReceiverTypes,
  makeCallSiteKey,
  makeSymbolCallKey,
  type ReceiverCalls,
  type ReturnSource,
  type ReturnSources,
  receiverHead,
} from "./call-site"
import {
  boundClassWhere,
  collectParameterNames,
  newTrace,
  type ResolutionHit,
  type ResolutionRun,
  type ResolutionTrace,
  resolveReference,
  resolveTarget,
  resolveThroughDeclaredType,
  resolveThroughImportedValue,
  resolveThroughReturnedClass,
  splitTargetSegments,
} from "./callgraph-scopes"
import type { ReceiverHint } from "./lsp/enrich"
import type { LspConsumerRejection } from "./lsp/stats"

export type LspHintOutcome =
  | { outcome: "hit"; hit: ResolutionHit }
  | { outcome: "absent" }
  | { outcome: "rejected"; reason: LspConsumerRejection }

export interface CallOutcome {
  readonly hit: ResolutionHit | null
  readonly trace: ResolutionTrace
  /** The language server's hint, read where the untyped tier left the call unresolved. */
  readonly hinted: LspHintOutcome | null
}

export interface CallResolverInput {
  readonly run: ResolutionRun
  readonly symbols: readonly IRSymbol[]
  readonly receiverHints: ReadonlyMap<string, ReceiverHint>
  readonly declaredReceiverTypes: DeclaredReceiverTypes
  readonly importedReceivers: ReadonlySet<string>
  readonly receiverCalls: ReceiverCalls
  readonly returnSources: ReturnSources
}

interface WrittenCall {
  readonly symbol: IRSymbol
  readonly call: Call
}

/**
 * Resolves a call once, whichever asks first: the call graph walking its Symbols, or a call whose
 * receiver is what that call gave back.
 */
export class CallResolver {
  readonly #input: CallResolverInput
  readonly #outcomes = new Map<string, CallOutcome>()
  readonly #pending = new Set<string>()
  readonly #parameterNames = new Map<SymbolId, ReadonlySet<string>>()
  readonly #returnedClasses = new Map<SymbolId, IRSymbol | null>()
  #sites: ReadonlyMap<string, WrittenCall | null> | null = null

  constructor(input: CallResolverInput) {
    this.#input = input
  }

  outcomeOf(symbol: IRSymbol, call: Call): CallOutcome {
    const key = makeSymbolCallKey(symbol.id, call.line, call.target)
    const known = this.#outcomes.get(key)
    if (known !== undefined) return known
    this.#pending.add(key)
    const outcome = this.#resolve(symbol, call, key)
    this.#pending.delete(key)
    this.#outcomes.set(key, outcome)
    return outcome
  }

  #resolve(symbol: IRSymbol, call: Call, key: string): CallOutcome {
    const { run, declaredReceiverTypes, importedReceivers, receiverCalls } = this.#input
    const trace = newTrace()
    const ctx = {
      run,
      caller: symbol,
      target: call.target,
      imports: run.importsByFile.get(symbol.source.file) ?? [],
      parameterNames: this.#parametersOf(symbol),
    }
    const declaredType = (): ResolutionHit | null => {
      const type = declaredReceiverTypes.get(key)
      if (type !== undefined) return resolveThroughDeclaredType(ctx, type)
      if (importedReceivers.has(key)) return resolveThroughImportedValue(ctx)
      const site = receiverCalls.get(key)
      return site === undefined
        ? null
        : resolveThroughReturnedClass(ctx, this.#classReturnedAt(site))
    }
    // A type the source declares, a receiver's, `super`'s, an imported variable's or a call's
    // result's, is the untyped tier's, so a language server only lifts what it leaves. For
    // `this.<method>` the server reads the class `this` is, inherited members included, so the
    // class's own member answers only what its hint leaves.
    const throughThis = isThisMember(call.target)
    const hit = resolveTarget(ctx, trace) ?? (throughThis ? null : declaredType())
    if (hit !== null) return { hit, trace, hinted: null }
    const hinted = resolveViaLspHint(
      call.target,
      this.#input.receiverHints.get(makeCallSiteKey(symbol.source.file, call.line, call.target)),
      run.table.keptSymbolIds,
    )
    if (hinted.outcome === "hit") return { hit: hinted.hit, trace, hinted }
    return { hit: throughThis ? declaredType() : null, trace, hinted }
  }

  #parametersOf(symbol: IRSymbol): ReadonlySet<string> {
    const known = this.#parameterNames.get(symbol.id)
    if (known !== undefined) return known
    const names = collectParameterNames(symbol)
    this.#parameterNames.set(symbol.id, names)
    return names
  }

  // A low-confidence callee is a namesake by spelling, whose return says nothing of the call's.
  #classReturnedAt(site: string): IRSymbol | null {
    const written = this.#sitesByKey().get(site)
    if (written == null || written.call.resolved !== null) return null
    const { symbol, call } = written
    if (this.#pending.has(makeSymbolCallKey(symbol.id, call.line, call.target))) return null
    const hit = this.outcomeOf(symbol, call).hit
    return hit === null || hit.confidence === "low" ? null : this.#classReturnedBy(hit.id)
  }

  // Each function names one source, so a chain that comes round again has no class to end at.
  #classReturnedBy(id: SymbolId): IRSymbol | null {
    const known = this.#returnedClasses.get(id)
    if (known !== undefined) return known
    this.#returnedClasses.set(id, null)
    const callee = this.#input.run.table.allById.get(id)
    const source = this.#input.returnSources.get(id)
    const owner =
      callee === undefined || source === undefined ? null : this.#classOfSource(callee, source)
    this.#returnedClasses.set(id, owner)
    return owner
  }

  #classOfSource(callee: IRSymbol, source: ReturnSource): IRSymbol | null {
    const { run } = this.#input
    if ("type" in source) return boundClassWhere(run, callee, source.type)
    if ("callSite" in source) return this.#classReturnedAt(source.callSite)
    const hit = resolveReference(run, callee, source.reference)
    return hit === null || hit.confidence === "low" ? null : this.#classReturnedBy(hit.id)
  }

  // Two calls written alike on one line cannot be told apart, so neither is a receiver's.
  #sitesByKey(): ReadonlyMap<string, WrittenCall | null> {
    if (this.#sites !== null) return this.#sites
    const sites = new Map<string, WrittenCall | null>()
    for (const symbol of this.#input.symbols) {
      for (const call of symbol.calls) {
        const site = makeCallSiteKey(symbol.source.file, call.line, call.target)
        sites.set(site, sites.has(site) ? null : { symbol, call })
      }
    }
    this.#sites = sites
    return sites
  }
}

function isThisMember(target: string): boolean {
  const segments = splitTargetSegments(target)
  return segments.length === 2 && segments[0] === "this"
}

function resolveViaLspHint(
  target: string,
  hint: ReceiverHint | undefined,
  keptSymbolIds: ReadonlySet<SymbolId>,
): LspHintOutcome {
  if (hint === undefined) return { outcome: "absent" }
  if (receiverHead(target) !== hint.kind) return { outcome: "rejected", reason: "kindMismatch" }
  if (!keptSymbolIds.has(hint.targetSymbolId)) {
    return { outcome: "rejected", reason: "targetDropped" }
  }
  return { outcome: "hit", hit: { id: hint.targetSymbolId, confidence: "high" } }
}

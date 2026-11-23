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
  boundClass,
  boundClassWhere,
  collectParameterNames,
  importedValueClassOf,
  newTrace,
  type ResolutionHit,
  type ResolutionRun,
  type ResolutionTrace,
  type ResolveTargetContext,
  resolveReference,
  resolveTarget,
  resolveThroughDeclaredType,
  resolveThroughImportedValue,
  resolveThroughValueOf,
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
  /** The language server's hint, where the resolver read one. */
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
  readonly #receiverClasses = new Map<string, IRSymbol | null>()
  readonly #returnedClasses = new Map<SymbolId, IRSymbol | null>()
  #sites: ReadonlyMap<string, WrittenCall | null> | null = null

  constructor(input: CallResolverInput) {
    this.#input = input
  }

  outcomeOf(symbol: IRSymbol, call: Call): CallOutcome {
    const key = makeSymbolCallKey(symbol.id, call.line, call.target)
    const known = this.#outcomes.get(key)
    if (known !== undefined) return known
    // A receiver that comes round to the call itself has no class to end at.
    if (this.#pending.has(key)) return { hit: null, trace: newTrace(), hinted: null }
    this.#pending.add(key)
    const outcome = this.#resolve(symbol, call, key)
    this.#pending.delete(key)
    this.#outcomes.set(key, outcome)
    return outcome
  }

  #resolve(symbol: IRSymbol, call: Call, key: string): CallOutcome {
    const { run, declaredReceiverTypes, importedReceivers, receiverCalls } = this.#input
    const trace = newTrace()
    const ctx = this.#contextOf(symbol, call)
    const declaredType = (): ResolutionHit | null => {
      const type = declaredReceiverTypes.get(key)
      if (type !== undefined) return resolveThroughDeclaredType(ctx, type)
      if (importedReceivers.has(key)) return resolveThroughImportedValue(ctx)
      const site = receiverCalls.get(key)
      return site === undefined ? null : resolveThroughValueOf(ctx, this.#classReturnedAt(site))
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

  #contextOf(symbol: IRSymbol, call: Call): ResolveTargetContext {
    const { run } = this.#input
    return {
      run,
      caller: symbol,
      target: call.target,
      imports: run.importsByFile.get(symbol.source.file) ?? [],
      parameterNames: this.#parametersOf(symbol),
    }
  }

  // The class of the value the receiver holds, where the source says: a type it is declared with,
  // an imported variable's, or what the call it is the result of gives back.
  #receiverClassOf(symbol: IRSymbol, call: Call): IRSymbol | null {
    const key = makeSymbolCallKey(symbol.id, call.line, call.target)
    const known = this.#receiverClasses.get(key)
    if (known !== undefined) return known
    // Calls resolved before the resolver ran can name each other as receivers with nothing between.
    this.#receiverClasses.set(key, null)
    const { declaredReceiverTypes, importedReceivers, receiverCalls } = this.#input
    const ctx = this.#contextOf(symbol, call)
    const type = declaredReceiverTypes.get(key)
    const site = receiverCalls.get(key)
    let owner: IRSymbol | null = null
    if (type !== undefined) owner = isThroughSuper(call.target) ? null : boundClass(ctx, type)
    else if (importedReceivers.has(key)) owner = importedValueClassOf(ctx)
    else if (site !== undefined) owner = this.#classReturnedAt(site)
    this.#receiverClasses.set(key, owner)
    return owner
  }

  #parametersOf(symbol: IRSymbol): ReadonlySet<string> {
    const known = this.#parameterNames.get(symbol.id)
    if (known !== undefined) return known
    const names = collectParameterNames(symbol)
    this.#parameterNames.set(symbol.id, names)
    return names
  }

  // A method that gives back `this` gives back its receiver, whose class the call was made through.
  #classReturnedAt(site: string): IRSymbol | null {
    const written = this.#sitesByKey().get(site)
    if (written == null) return null
    const { symbol, call } = written
    const callee = this.#calleeOf(symbol, call)
    if (callee === null) return null
    const source = this.#input.returnSources.get(callee)
    if (source !== undefined && "self" in source) return this.#receiverClassOf(symbol, call)
    return this.#classReturnedBy(callee)
  }

  // A low-confidence callee is a namesake by spelling, whose return says nothing of the call's.
  #calleeOf(symbol: IRSymbol, call: Call): SymbolId | null {
    if (call.resolved !== null) return call.resolved
    const hit = this.outcomeOf(symbol, call).hit
    return hit === null || hit.confidence === "low" ? null : hit.id
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

  // Reached by name rather than through a call, a method that gives back `this` has no receiver.
  #classOfSource(callee: IRSymbol, source: ReturnSource): IRSymbol | null {
    const { run } = this.#input
    if ("type" in source) return boundClassWhere(run, callee, source.type)
    if ("callSite" in source) return this.#classReturnedAt(source.callSite)
    if ("self" in source) return null
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

function isThroughSuper(target: string): boolean {
  return splitTargetSegments(target)[0] === "super"
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

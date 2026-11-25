import type {
  Call,
  CallCandidate,
  ComponentId,
  Config,
  DeclinedCall,
  Decorator,
  Effect,
  EffectClassification,
  EffectDecline,
  EffectPlugin,
  ImportEdge,
  LanguageId,
  OpaqueAstNode,
  OwnerDecorator,
  OwnerSummary,
  SourceFile,
  SymbolCandidate,
  VocabRegistry,
} from "@aburi/types"
import {
  type CallSiteBinding,
  type DeclaredReceiverType,
  isCallSiteRef,
  isThisBinding,
  makeCallSiteKey,
  makeSymbolCallKey,
  type ReceiverCallEntry,
} from "../call-site"
import { CoreError } from "../errors"
import type { DropCFilter } from "./drop-c"
import { normalizeCallStrings } from "./normalize"
import {
  type ClassifyTimeoutEvent,
  type ClassifyWithTimeoutOptions,
  classifyWithTimeout,
} from "./timeout"
import type { VocabCheck } from "./vocab"

export interface ClassifyCallsInput {
  calls: readonly CallCandidate[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  config: Config
  component: ComponentId | null
  candidate: SymbolCandidate<OpaqueAstNode>
  file: SourceFile
  language: LanguageId
  imports: readonly ImportEdge[]
  /** Calls of a method the workspace declares on the receiver's class: no plugin is asked. */
  memberCalls?: ReadonlySet<CallCandidate>
  dropCFilter: DropCFilter
  timeoutEvents: ClassifyTimeoutEvent[]
  vocab: VocabCheck
  classifyTimeoutMs?: number
}

function ownerDecorator(decorator: Decorator): OwnerDecorator {
  const { name, qualifier, boundary } = decorator
  return qualifier === undefined ? { name, boundary } : { name, qualifier, boundary }
}

export function classifyCalls(input: ClassifyCallsInput): {
  effects: Effect[]
  calls: Call[]
  dynamicCallSites: string[]
  declinedCalls: DeclinedCall[]
  thisBindings: CallSiteBinding[]
  declaredReceiverTypes: DeclaredReceiverType[]
  importedReceivers: string[]
  receiverCalls: ReceiverCallEntry[]
  unboundHeads: string[]
} {
  const classifiedEffects: Effect[] = []
  const survivingCalls: Call[] = []
  const dynamicCallSites: string[] = []
  const declinedCalls: DeclinedCall[] = []
  const thisBindings: CallSiteBinding[] = []
  // `null` once a key's calls stop naming one type, an untyped call's included.
  const declaredTypes = new Map<string, string | null>()
  // `false` once one of a key's calls goes through a name no import binds.
  const imported = new Map<string, boolean>()
  // `false` once one of a key's calls is not marked `unboundHead`.
  const unbound = new Map<string, boolean>()
  // `null` once a key's calls stop naming one call, a call with none included.
  const receiverCallSites = new Map<string, string | null>()
  const owner: OwnerSummary = {
    id: input.candidate.id,
    kind: input.candidate.kind,
    name: input.candidate.name,
    extKind: input.candidate.extKind,
    decorators: input.candidate.decorators.map(ownerDecorator),
    component: input.component,
  }

  for (const produced of input.calls) {
    const call = normalizeCallStrings(produced)
    if (input.dropCFilter.shouldDropCall(call)) continue

    const ctx = {
      owner,
      file: { path: input.file.path, imports: [...input.imports] },
      language: input.language,
      registry: input.registry,
      config: input.config,
    }

    let classified = false
    const declines: DeclinedCall[] = []
    const asked = input.memberCalls?.has(produced) === true ? [] : input.effects
    for (const effect of asked) {
      const timeoutOptions: ClassifyWithTimeoutOptions = {
        onTimeout: (event) => {
          input.timeoutEvents.push(event)
        },
      }
      if (input.classifyTimeoutMs !== undefined) timeoutOptions.timeoutMs = input.classifyTimeoutMs
      const result = classifyWithTimeout(
        effect,
        call,
        ctx,
        { symbolId: input.candidate.id, file: input.file.path },
        timeoutOptions,
      )
      if (result === null) continue
      if (isDecline(result, effect)) {
        declines.push({
          plugin: effect.manifest.name,
          symbolId: input.candidate.id,
          target: call.target,
          line: call.line,
          reason: declineReason(result, effect),
        })
        continue
      }
      input.vocab.effect({
        value: result.effectId,
        plugin: effect.manifest.name,
        file: input.file.path,
        line: call.line,
        symbol: input.candidate.id,
      })
      classifiedEffects.push({
        id: result.effectId,
        target: call.target,
        line: call.line,
        plugin: effect.manifest.name,
        confidence: result.confidence,
        derivedBy: result.derivedBy,
      })
      classified = true
      break
    }
    if (!classified) {
      declinedCalls.push(...declines)
      survivingCalls.push({ target: call.target, line: call.line, resolved: null })
      const key = makeCallSiteKey(input.file.path, call.line, call.target)
      if (call.dynamicReceiver === true) dynamicCallSites.push(key)
      if (isThisBinding(call.thisBinding)) thisBindings.push([key, call.thisBinding])
      const type =
        typeof call.receiverType === "string" && call.receiverType.length > 0
          ? call.receiverType
          : null
      const symbolKey = makeSymbolCallKey(input.candidate.id, call.line, call.target)
      const seen = declaredTypes.get(symbolKey)
      declaredTypes.set(symbolKey, seen === undefined || seen === type ? type : null)
      imported.set(symbolKey, imported.get(symbolKey) !== false && call.importedReceiver === true)
      unbound.set(symbolKey, unbound.get(symbolKey) !== false && call.unboundHead === true)
      const written = call.receiverCall
      const site = isCallSiteRef(written)
        ? makeCallSiteKey(input.file.path, written.line, written.target)
        : null
      const seenSite = receiverCallSites.get(symbolKey)
      receiverCallSites.set(symbolKey, seenSite === undefined || seenSite === site ? site : null)
    }
  }
  const declaredReceiverTypes: DeclaredReceiverType[] = []
  for (const [key, type] of declaredTypes)
    if (type !== null) declaredReceiverTypes.push([key, type])
  const importedReceivers = [...imported].flatMap(([key, through]) => (through ? [key] : []))
  const unboundHeads = [...unbound].flatMap(([key, none]) => (none ? [key] : []))
  const receiverCalls = [...receiverCallSites].flatMap(([key, site]): ReceiverCallEntry[] =>
    site === null ? [] : [[key, site]],
  )

  // Left in the plugin's order, which is source order: the Symbol sorts by line with a stable sort,
  // so two effects on one line keep the order they are written in, which `logic` reads.
  return {
    effects: classifiedEffects,
    calls: survivingCalls,
    dynamicCallSites,
    thisBindings,
    declaredReceiverTypes,
    importedReceivers,
    receiverCalls,
    unboundHeads,
    declinedCalls,
  }
}

function isDecline(
  result: EffectClassification | EffectDecline,
  effect: EffectPlugin,
): result is EffectDecline {
  if (!Object.hasOwn(result, "declined")) return false
  if (!Object.hasOwn(result, "effectId")) return true
  // TypeScript accepts an object carrying both keys as either member of the union.
  throw new CoreError(
    `Effect plugin "${effect.manifest.name}" answered one call with both \`effectId\` and \`declined\`: classify() must return an EffectClassification, an EffectDecline or null, not both.`,
    { code: "scan-plugin-misconfigured", value: effect.manifest.name },
  )
}

function declineReason(decline: EffectDecline, effect: EffectPlugin): string {
  const reason: unknown = decline.declined
  if (typeof reason === "string" && reason.trim().length > 0) return reason.normalize("NFC")
  throw new CoreError(
    `Effect plugin "${effect.manifest.name}" declined a call with no reason: \`declined\` must be a non-empty string.`,
    { code: "scan-plugin-misconfigured", value: effect.manifest.name },
  )
}

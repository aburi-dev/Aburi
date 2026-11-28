import {
  type CallResolutionStats,
  COMPUTED_TARGET_SEGMENT,
  type ImportEdge,
  type Symbol as IRSymbol,
  type UnresolvedCallBucket,
  type UnresolvedCallBuckets,
  type UnresolvedCallDiagnostic,
} from "@aburi/types"
import { type ResolutionTrace, splitTargetSegments } from "./callgraph-scopes"
import { isRelativeSpecifier } from "./callgraph-specifier"
import { exportNames } from "./export-names"
import { importBindsLocal } from "./import-edge"
import { compareCodeUnit } from "./order"

interface ClassifyUnresolvedInput {
  caller: IRSymbol
  target: string
  line: number
  imports: readonly ImportEdge[]
  trace: ResolutionTrace
  dynamicReceiver: boolean
  /** Whether a bare specifier the caller's file imports leads to a file the scan read. */
  reachesWorkspace?: (specifier: string) => boolean
  /** Whether no scope around the call declares the target's leading name. */
  unboundHead?: boolean
  /** What the workspace's declarations are named, when the call is read against them. */
  names?: WorkspaceNames
  /** The caller's file and the files its imports reach, whose declarations its values can be. */
  reachedFiles: () => ReadonlySet<string>
}

/**
 * What the workspace's Symbols are named, dropped ones included: every name a qualified name starts
 * with (`leading`), and every name one ends with or a module exports a declaration under. Those a
 * module exports, and those of the members of a declaration it exports, are `exported`, since any
 * module may be handed a value of it. The rest are `declaredIn` their files, whose values reach
 * only the file and the modules that import it.
 */
export interface WorkspaceNames {
  readonly leading: ReadonlySet<string>
  readonly exported: ReadonlySet<string>
  readonly declaredIn: ReadonlyMap<string, ReadonlySet<string>>
}

export function classifyUnresolved(input: ClassifyUnresolvedInput): UnresolvedCallDiagnostic {
  const base = {
    symbolId: input.caller.id,
    target: input.target,
    line: input.line,
  }
  if (input.trace.localShadow) {
    return { ...base, bucket: "local-scope", candidates: [] }
  }
  // Neither a receiver the resolver could name nor a choice between candidates would reach a callee
  // no declaration has.
  if (isOutOfReach(input)) {
    return { ...base, bucket: "external", candidates: [] }
  }
  if (input.dynamicReceiver || input.trace.unnamedReceiver) {
    return { ...base, bucket: "dynamic", candidates: [] }
  }
  if (input.trace.ambiguousCandidates.size > 0 || input.trace.conflictingExport) {
    return {
      ...base,
      bucket: "ambiguous",
      candidates: [...input.trace.ambiguousCandidates].sort(compareCodeUnit),
    }
  }
  return { ...base, bucket: "no-match", candidates: [] }
}

const NOWHERE = (): boolean => false

// A plugin outside the tree may mark any head, but `this`, `super` and a computed segment are
// receivers the scan cannot name, never a global.
const RECEIVER_HEADS: ReadonlySet<string> = new Set(["this", "super", COMPUTED_TARGET_SEGMENT])

// Through a function's own `call` and `apply` the function itself runs.
const INVOKING_MEMBERS: ReadonlySet<string> = new Set(["call", "apply"])

function isOutOfReach(input: ClassifyUnresolvedInput): boolean {
  if (input.trace.reexportedFromOutside) return true
  if (bindsToExternalImport(input.target, input.imports, input.reachesWorkspace ?? NOWHERE)) {
    return true
  }
  const { names } = input
  if (names === undefined) return false
  const segments = splitTargetSegments(input.target)
  const [head] = segments
  if (
    input.unboundHead === true &&
    head !== undefined &&
    !RECEIVER_HEADS.has(head) &&
    !names.leading.has(head)
  ) {
    return true
  }
  const member = segments.length > 1 ? segments.at(-1) : undefined
  return (
    member !== undefined &&
    member !== COMPUTED_TARGET_SEGMENT &&
    !INVOKING_MEMBERS.has(member) &&
    !canHold(names, member, input.reachedFiles)
  )
}

function canHold(
  names: WorkspaceNames,
  member: string,
  reachedFiles: () => ReadonlySet<string>,
): boolean {
  if (names.exported.has(member)) return true
  const files = names.declaredIn.get(member)
  if (files === undefined) return false
  const reached = reachedFiles()
  for (const file of files) if (reached.has(file)) return true
  return false
}

export function workspaceNamesOf(
  symbols: readonly IRSymbol[],
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>,
): WorkspaceNames {
  const leading = new Set<string>()
  const exported = new Set<string>()
  const declaredIn = new Map<string, Set<string>>()
  const record = (name: string, file: string, isExported: boolean): void => {
    if (isExported) exported.add(name)
    else addTo(declaredIn, name, file)
  }
  const privateTopLevel = privateTopLevelNames(symbols)
  for (const symbol of symbols) {
    const file = symbol.source.file
    const segments = symbol.name.split(QNAME_SEPARATOR)
    const [first] = segments
    const final = segments.at(-1)
    if (first !== undefined) leading.add(first)
    if (first !== undefined && final !== undefined) {
      record(final, file, privateTopLevel.get(file)?.has(first) !== true)
    }
    for (const name of exportNames(symbol)) record(name, file, true)
  }
  for (const [file, edges] of importsByFile) {
    for (const edge of edges) {
      for (const reexport of edge.reexports ?? []) record(reexport.exported, file, true)
    }
  }
  return { leading, exported, declaredIn }
}

// A member whose owner has no Symbol of its file may be of an exported declaration, and counts as one.
function privateTopLevelNames(symbols: readonly IRSymbol[]): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>()
  const exported = new Map<string, Set<string>>()
  for (const symbol of symbols) {
    if (QNAME_SEPARATOR.test(symbol.name)) continue
    addTo(declared, symbol.source.file, symbol.name)
    if (exportNames(symbol).length > 0) addTo(exported, symbol.source.file, symbol.name)
  }
  for (const [file, names] of declared) {
    for (const name of exported.get(file) ?? []) names.delete(name)
  }
  return declared
}

function addTo(sets: Map<string, Set<string>>, key: string, value: string): void {
  const set = sets.get(key)
  if (set === undefined) sets.set(key, new Set([value]))
  else set.add(value)
}

const QNAME_SEPARATOR = /::|\./

function bindsToExternalImport(
  target: string,
  imports: readonly ImportEdge[],
  reachesWorkspace: (specifier: string) => boolean,
): boolean {
  const [head] = splitTargetSegments(target)
  if (head === undefined) return false
  return imports.some(
    (edge) =>
      importBindsLocal(edge, head) &&
      !isRelativeSpecifier(edge.source) &&
      !reachesWorkspace(edge.source),
  )
}

export function buildCallResolutionStats(
  totalCalls: number,
  resolvedCalls: number,
  diagnostics: readonly UnresolvedCallDiagnostic[],
): CallResolutionStats {
  const unresolved: UnresolvedCallBuckets = {
    localScope: 0,
    external: 0,
    dynamic: 0,
    ambiguous: 0,
    noMatch: 0,
  }
  for (const diagnostic of diagnostics) {
    unresolved[BUCKET_TO_STATS_KEY[diagnostic.bucket]]++
  }
  return { totalCalls, resolvedCalls, unresolved }
}

const BUCKET_TO_STATS_KEY: Record<UnresolvedCallBucket, keyof UnresolvedCallBuckets> = {
  "local-scope": "localScope",
  external: "external",
  dynamic: "dynamic",
  ambiguous: "ambiguous",
  "no-match": "noMatch",
}

export function compareDiagnostic(
  a: UnresolvedCallDiagnostic,
  b: UnresolvedCallDiagnostic,
): number {
  return (
    compareCodeUnit(a.symbolId, b.symbolId) ||
    a.line - b.line ||
    compareCodeUnit(a.target, b.target)
  )
}

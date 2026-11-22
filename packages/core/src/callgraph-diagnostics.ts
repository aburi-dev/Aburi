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
import { splitAliasedImportName } from "./import-edge"
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
}

/**
 * Every name a Symbol's qualified name starts with (`leading`) or ends with (`last`), dropped ones
 * included, and in `last` every name a module exports a declaration under.
 */
export interface WorkspaceNames {
  readonly leading: ReadonlySet<string>
  readonly last: ReadonlySet<string>
}

export function classifyUnresolved(input: ClassifyUnresolvedInput): UnresolvedCallDiagnostic {
  const base = {
    symbolId: input.caller.id,
    target: input.target,
    line: input.line,
  }
  if (input.trace.parameterShadow) {
    return { ...base, bucket: "local-scope", candidates: [] }
  }
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

// No declaration the scan read can be the callee: a package's, a global's, or a member nothing in
// the workspace names, whatever the receiver holds.
function isOutOfReach(input: ClassifyUnresolvedInput): boolean {
  if (input.trace.reexportedFromOutside) return true
  if (bindsToExternalImport(input.target, input.imports, input.reachesWorkspace ?? NOWHERE)) {
    return true
  }
  const { names } = input
  if (names === undefined) return false
  const segments = splitTargetSegments(input.target)
  const [head] = segments
  if (input.unboundHead === true && head !== undefined && !names.leading.has(head)) return true
  const member = segments.length > 1 ? segments.at(-1)?.replace(/!$/, "") : undefined
  return member !== undefined && member !== COMPUTED_TARGET_SEGMENT && !names.last.has(member)
}

export function workspaceNamesOf(
  symbols: readonly IRSymbol[],
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>,
): WorkspaceNames {
  const leading = new Set<string>()
  const last = new Set<string>()
  for (const symbol of symbols) {
    const segments = symbol.name.split(QNAME_SEPARATOR)
    const [first] = segments
    const final = segments.at(-1)
    if (first !== undefined) leading.add(first)
    if (final !== undefined) last.add(final)
    for (const name of exportNames(symbol)) last.add(name)
  }
  for (const edges of importsByFile.values()) {
    for (const edge of edges) for (const { exported } of edge.reexports ?? []) last.add(exported)
  }
  return { leading, last }
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
      !edge.dynamic &&
      !isRelativeSpecifier(edge.source) &&
      !reachesWorkspace(edge.source) &&
      (edge.symbols === "*"
        ? edge.namespaceBinding === head
        : edge.symbols.some((raw) => splitAliasedImportName(raw).local === head)),
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

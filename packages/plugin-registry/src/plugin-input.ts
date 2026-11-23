import {
  type CallCandidate,
  type Confidence,
  type ImportBinding,
  type ImportEdge,
  PLUGIN_SCHEMA_URL,
} from "@aburi/types"

export type NonEmptySegments = readonly [string, ...string[]]

export interface PluginInputOrigin {
  /** Plugin name used as the message prefix, e.g. `"effects-drizzle"`. */
  readonly plugin: string
  /** Path of the source file the candidate came from. */
  readonly filePath: string
}

export type PluginInputErrorCode =
  /** `CallCandidate.target` is empty or has an empty segment. */
  | "unnormalized-callee"
  /** `ImportEdge.source` is empty. */
  | "unnormalized-import-source"
  /** An `ImportEdge.symbols` entry has an empty half. */
  | "unnormalized-import-binding"
  /** `ImportEdge.namespaceBinding` is empty. */
  | "unnormalized-namespace-binding"

/** A language plugin's output that breaks the contract the guard's caller reads it under. */
export class PluginInputError extends Error {
  readonly code: PluginInputErrorCode
  /** The plugin whose guard refused the value. */
  readonly plugin: string
  readonly filePath: string

  constructor(message: string, code: PluginInputErrorCode, origin: PluginInputOrigin) {
    super(message)
    this.name = "PluginInputError"
    this.code = code
    this.plugin = origin.plugin
    this.filePath = origin.filePath
  }
}

export interface CallTargetSegments {
  readonly segments: NonEmptySegments
  readonly last: string
}

export function assertNonEmptySegments(
  target: string,
  origin: PluginInputOrigin,
): CallTargetSegments {
  const where = `${origin.plugin} (${origin.filePath})`
  if (target.length === 0) {
    throw new PluginInputError(
      `${where}: CallCandidate.target is empty — language plugin emitted an unnormalized callee`,
      "unnormalized-callee",
      origin,
    )
  }

  const [first = "", ...rest] = target.split(".")

  const emptySegment = () =>
    new PluginInputError(
      `${where}: CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`,
      "unnormalized-callee",
      origin,
    )
  if (first.length === 0) throw emptySegment()

  let last = first
  for (const segment of rest) {
    if (segment.length === 0) throw emptySegment()
    last = segment
  }

  return { segments: [first, ...rest], last }
}

export function assertImportEdgeSource(edge: ImportEdge, origin: PluginInputOrigin): void {
  if (edge.source.length > 0) return
  throw new PluginInputError(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.source is empty — language plugin emitted an unnormalized import edge`,
    "unnormalized-import-source",
    origin,
  )
}

export type ImportBindingHalves = ImportBinding

export function assertImportBinding(
  binding: ImportBindingHalves,
  raw: string,
  edge: ImportEdge,
  origin: PluginInputOrigin,
): void {
  if (binding.imported.length > 0 && binding.local.length > 0) return
  throw new PluginInputError(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.symbols entry "${raw}" has an empty half — language plugin emitted an unnormalized import edge`,
    "unnormalized-import-binding",
    origin,
  )
}

export function assertNamespaceBinding(
  binding: string,
  edge: ImportEdge,
  origin: PluginInputOrigin,
): void {
  if (binding.length > 0) return
  throw new PluginInputError(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.namespaceBinding is empty — language plugin emitted an unnormalized import edge`,
    "unnormalized-namespace-binding",
    origin,
  )
}

export function hasMatchingImport(
  imports: readonly ImportEdge[],
  origin: PluginInputOrigin,
  matches: (source: string) => boolean,
): boolean {
  for (const edge of imports) assertImportEdgeSource(edge, origin)
  return imports.some((edge) => matches(edge.source))
}

/** An import binding a local name: the edge that binds it and the name its module exports. */
export interface BoundImport {
  readonly edge: ImportEdge
  /** The name the edge's module exports, `*` for a namespace import. */
  readonly imported: string
}

/**
 * The import that binds `local` in the module, or `null` where none does: a named or default
 * import whose local it is, or a namespace import under that name. The last edge wins, as the last
 * declaration of a name would; a module that compiles binds each name once.
 */
export function importBindingOf(
  imports: readonly ImportEdge[],
  local: string,
  origin: PluginInputOrigin,
): BoundImport | null {
  let bound: BoundImport | null = null
  for (const edge of imports) {
    assertImportEdgeSource(edge, origin)
    bound = edgeBinding(edge, local, origin) ?? bound
  }
  return bound
}

function edgeBinding(
  edge: ImportEdge,
  local: string,
  origin: PluginInputOrigin,
): BoundImport | null {
  if (edge.dynamic) return null
  if (edge.symbols === "*") {
    if (edge.namespaceBinding === undefined) return null
    assertNamespaceBinding(edge.namespaceBinding, edge, origin)
    return edge.namespaceBinding === local ? { edge, imported: "*" } : null
  }
  let bound: BoundImport | null = null
  for (const binding of bindingsOf(edge, origin)) {
    if (binding.local === local) bound = { edge, imported: binding.imported }
  }
  return bound
}

// Every call of a file looks its leading name up again in the same edges.
const edgeBindings = new WeakMap<ImportEdge, readonly ImportBindingHalves[]>()

function bindingsOf(edge: ImportEdge, origin: PluginInputOrigin): readonly ImportBindingHalves[] {
  let bindings = edgeBindings.get(edge)
  if (bindings === undefined) {
    const written = edge.symbols === "*" ? [] : edge.symbols
    bindings = written.map((raw) => {
      const binding = importBindingHalves(raw)
      assertImportBinding(binding, raw, edge, origin)
      return binding
    })
    edgeBindings.set(edge, bindings)
  }
  return bindings
}

// As `@aburi/core` splits an entry, which this package cannot import.
function importBindingHalves(raw: string): ImportBindingHalves {
  const marker = raw.indexOf(" as ")
  if (marker < 0) return { imported: raw.trim(), local: raw.trim() }
  return { imported: raw.slice(0, marker).trim(), local: raw.slice(marker + 4).trim() }
}

/**
 * How far the file's imports place a call's client: `direct` when the file, or the import that
 * binds the call's leading name, leads to a matching module; `reached` when only a workspace module
 * the file imports from does, beside what it binds (`ImportEdge.upstream`), as `./prisma.service`
 * does for `PrismaService` beside `@prisma/client`; `null` when nothing does.
 */
export type ImportGate = "direct" | "reached" | null

export function importGate(
  imports: readonly ImportEdge[],
  head: string,
  origin: PluginInputOrigin,
  matches: (source: string) => boolean,
): ImportGate {
  const facts = edgeFactsFor(matches)
  let direct = false
  let reached = false
  let bound: BoundImport | null = null
  for (const edge of imports) {
    assertImportEdgeSource(edge, origin)
    const fact = facts(edge)
    direct ||= fact.direct
    reached ||= fact.reaches
    bound = edgeBinding(edge, head, origin) ?? bound
  }
  if (direct) return "direct"
  if (bound !== null && bindingReachesMatchingImport(bound, matches)) return "direct"
  return reached ? "reached" : null
}

// Through its own specifier, or through what the workspace module declaring the name imports.
function bindingReachesMatchingImport(
  bound: BoundImport,
  matches: (source: string) => boolean,
): boolean {
  if (matches(bound.edge.source)) return true
  return (bound.edge.upstream?.get(bound.imported) ?? []).some(matches)
}

interface EdgeFacts {
  /** The edge's own specifier matches. */
  readonly direct: boolean
  /** A specifier in the edge's `upstream` matches. */
  readonly reaches: boolean
}

// Every call of a file asks again of the same edges, and an edge's `upstream` can be long.
const edgeFactsByMatcher = new WeakMap<
  (source: string) => boolean,
  (edge: ImportEdge) => EdgeFacts
>()

function edgeFactsFor(matches: (source: string) => boolean): (edge: ImportEdge) => EdgeFacts {
  let facts = edgeFactsByMatcher.get(matches)
  if (facts === undefined) {
    const known = new WeakMap<ImportEdge, EdgeFacts>()
    facts = (edge) => {
      let fact = known.get(edge)
      if (fact === undefined) {
        const upstream = edge.upstream === undefined ? [] : [...edge.upstream.values()]
        fact = {
          direct: matches(edge.source),
          reaches: upstream.some((sources) => sources.some(matches)),
        }
        known.set(edge, fact)
      }
      return fact
    }
    edgeFactsByMatcher.set(matches, facts)
  }
  return facts
}

/**
 * Whether the type a receiver is declared with is a matching module's, read through the import
 * that binds its first segment: the edge's own module, or the one its re-exports end at
 * (`ImportEdge.origins`). `false` where no import binds it or the call carries no type.
 */
export function receiverTypeFromMatchingModule(
  imports: readonly ImportEdge[],
  receiverType: string | undefined,
  origin: PluginInputOrigin,
  matches: (source: string) => boolean,
): boolean {
  if (receiverType === undefined || receiverType.length === 0) return false
  const [head = receiverType] = receiverType.split(".")
  const bound = importBindingOf(imports, head, origin)
  if (bound === null) return false
  return matches(bound.edge.origins?.get(bound.imported) ?? bound.edge.source)
}

export function identifierWords(name: string): string[] {
  const words: string[] = []
  for (const chunk of name.split(/[^A-Za-z0-9]+/)) {
    for (const word of chunk.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []) {
      words.push(word.toLowerCase())
    }
  }
  return words
}

export function identifierMentions(name: string, vocabulary: ReadonlySet<string>): boolean {
  return identifierWords(name).some((word) => vocabulary.has(word))
}

export function hasLiteralFirstArgument(call: Pick<CallCandidate, "literalArgs">): boolean {
  return (call.literalArgs[0] ?? null) !== null
}

export function matchesModuleOrSubpath(...roots: readonly string[]): (source: string) => boolean {
  return (source) => roots.some((root) => source === root || source.startsWith(`${root}/`))
}

export function receiverConfidence(
  clientSegment: string | undefined,
  call: Pick<CallCandidate, "dynamicReceiver" | "argumentCount">,
  maxArguments: number,
  namesClient: (segment: string) => boolean,
): Confidence {
  if (call.dynamicReceiver === true) return "medium"
  if (call.argumentCount > maxArguments) return "medium"
  if (clientSegment !== undefined && namesClient(clientSegment)) return "high"
  return "medium"
}

/** The tier of a receiver whose declared type is the library's own: a recognised name's. */
export function typedReceiverConfidence(
  call: Pick<CallCandidate, "dynamicReceiver" | "argumentCount">,
  maxArguments: number,
): Confidence {
  if (call.dynamicReceiver === true) return "medium"
  return call.argumentCount > maxArguments ? "medium" : "high"
}

export interface EffectsPluginManifest<Name extends string, DerivedByPrefix extends string> {
  readonly $schema: typeof PLUGIN_SCHEMA_URL
  readonly name: Name
  readonly version: "0.0.0"
  readonly type: "effects"
  readonly engines: { readonly aburi: "*" }
  readonly provides: {
    readonly effects: []
    readonly effectPrefixes: []
    readonly extKinds: []
    readonly extKindPrefixes: []
    readonly derivedByPrefixes: [DerivedByPrefix]
    readonly frameworks: []
  }
}

export function defineEffectsManifest<Name extends string, DerivedByPrefix extends string>(
  name: Name,
  derivedByPrefix: DerivedByPrefix,
): EffectsPluginManifest<Name, DerivedByPrefix> {
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name,
    version: "0.0.0",
    type: "effects",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: [],
      derivedByPrefixes: [derivedByPrefix],
      frameworks: [],
    },
  }
}

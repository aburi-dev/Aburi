import {
  type Confidence,
  EXPORT_DEFAULT_DERIVED_BY,
  type ImportEdge,
  type Symbol as IRSymbol,
  type SymbolId,
} from "@aburi/types"
import { componentKeyOf, type SymbolTable } from "./callgraph-index"
import { dirname, isRelativeSpecifier, resolveRelativeSpecifier } from "./callgraph-specifier"
import { DEFAULT_EXPORT_QNAME, trySymbolId } from "./id"
import { DEFAULT_EXPORT_NAME, splitAliasedImportName } from "./import-edge"

export interface ResolutionTrace {
  ambiguousCandidates: Set<SymbolId>
  parameterShadow: boolean
  unnamedReceiver: boolean
  /** A re-export the head's import leads through names a bare specifier outside the workspace. */
  reexportedFromOutside: boolean
}

export function newTrace(): ResolutionTrace {
  return {
    ambiguousCandidates: new Set(),
    parameterShadow: false,
    unnamedReceiver: false,
    reexportedFromOutside: false,
  }
}

export function collectParameterNames(symbol: IRSymbol): ReadonlySet<string> {
  const inputs = symbol.signature?.inputs
  if (inputs === undefined) return EMPTY_NAME_SET
  const out = new Set<string>()
  for (const input of inputs) {
    out.add(input.name)
    if (input.bindings === undefined) continue
    for (const binding of input.bindings) out.add(binding)
  }
  return out
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set()

export interface ResolutionHit {
  id: SymbolId
  confidence: Confidence
}

export interface ResolutionRun {
  table: SymbolTable
  extensions: readonly string[]
  relativeTargets: Map<string, string | null>
  /** By importing file, then by bare specifier: the paths its language maps the specifier to. */
  specifierPaths: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>
  mappedTargets: Map<string, string | null>
  /** Every file's import edges, which say what a module re-exports. */
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>
  /** By language, file and name: where a module's export of the name is declared. */
  exportAnswers: Map<string, ExportAnswer>
}

export interface ResolveTargetContext {
  run: ResolutionRun
  caller: IRSymbol
  target: string
  imports: readonly ImportEdge[]
  parameterNames: ReadonlySet<string>
}

export function resolveTarget(
  ctx: ResolveTargetContext,
  trace: ResolutionTrace,
): ResolutionHit | null {
  const [head, ...tail] = splitTargetSegments(ctx.target)
  if (head === undefined) {
    trace.unnamedReceiver = true
    return null
  }

  if (ctx.parameterNames.has(head)) {
    trace.parameterShadow = true
    return null
  }

  if (head === "this" || head === "super") {
    trace.unnamedReceiver = true
    return null
  }

  // Component and workspace scope match the whole target by spelling, so past the declaration a
  // head is bound to they could only find a namesake.
  const bound =
    resolveInFileScope(ctx, head, tail, trace) ?? resolveInImportScope(ctx, head, tail, trace)
  if (bound !== null) return bound.hit
  if (tail.length === 0) return null
  return resolveInComponentScope(ctx, trace) ?? resolveInWorkspaceScope(ctx, trace)
}

export function resolveThroughDeclaredType(
  ctx: ResolveTargetContext,
  type: string | undefined,
): ResolutionHit | null {
  if (type === undefined) return null
  const segments = splitTargetSegments(ctx.target)
  const member = segments.at(-1)
  const [head, ...tail] = splitTargetSegments(type)
  if (segments.length < 2 || member === undefined || head === undefined) return null
  const typeCtx = { ...ctx, target: type }
  // Not component or workspace scope: matching a type by its spelling could only find a namesake.
  const trace = newTrace()
  const bound =
    resolveInFileScope(typeCtx, head, tail, trace) ??
    resolveInImportScope(typeCtx, head, tail, trace)
  const owner = bound?.hit == null ? undefined : ctx.run.table.keptById.get(bound.hit.id)
  if (owner?.kind !== "class") return null
  const id = trySymbolId({
    language: owner.language,
    file: owner.source.file,
    qualifiedName: `${owner.name}.${member}`,
  })
  if (id === null || !ctx.run.table.keptSymbolIds.has(id)) return null
  // The value may be a subclass's, whose override then runs.
  return { id, confidence: "medium" }
}

interface BoundHead {
  hit: ResolutionHit | null
}

const NO_MEMBER: BoundHead = { hit: null }

function resolveInFileScope(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
  trace: ResolutionTrace,
): BoundHead | null {
  const file = ctx.caller.source.file
  const owned = ownsMembers(ctx, file, head)
  const declared = ctx.run.table.topLevelByFile.get(file)?.get(head)
  if (declared !== undefined) {
    const anchor = soleCandidate(declared, trace)
    if (anchor === null) return null
    if (tail.length === 0) return { hit: { id: anchor.id, confidence: "high" } }
  } else if (!owned) {
    return null
  }
  const id = memberId(ctx, file, head, tail)
  if (id !== null) return { hit: { id, confidence: "high" } }
  return owned ? NO_MEMBER : null
}

function ownsMembers(ctx: ResolveTargetContext, file: string, name: string): boolean {
  return ctx.run.table.memberOwnersByFile.get(file)?.has(name) === true
}

function memberId(
  ctx: ResolveTargetContext,
  file: string,
  first: string,
  tail: readonly string[],
): SymbolId | null {
  const keptId = (qualifiedName: string) => {
    const id = trySymbolId({ language: ctx.caller.language, file, qualifiedName })
    return id !== null && ctx.run.table.keptSymbolIds.has(id) ? id : null
  }
  let qualifiedName = first
  for (const segment of tail) {
    const staticName = `${qualifiedName}::${segment}`
    qualifiedName = keptId(staticName) === null ? `${qualifiedName}.${segment}` : staticName
  }
  return keptId(qualifiedName)
}

function resolveInImportScope(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
  trace: ResolutionTrace,
): BoundHead | null {
  const imported = importedNamesOf(ctx, head, tail)
  const renamed = imported.renamed
  const names = imported.names.flatMap((entry) => declarationsOf(ctx, entry, trace))
  const candidates = new Set<SymbolId>()
  for (const { file, name, rest } of names) {
    const id = memberId(ctx, file, name, rest)
    if (id !== null) candidates.add(id)
  }
  const [only, ...others] = candidates
  if (only !== undefined && others.length === 0) return { hit: { id: only, confidence: "high" } }
  for (const id of candidates) trace.ambiguousCandidates.add(id)
  // Under an alias, or a default or namespace import, the target never spells the declaration's
  // name, so the import binds the head even where the module does not declare it.
  const bound = renamed || names.some(({ file, name }) => ownsMembers(ctx, file, name))
  return bound ? NO_MEMBER : null
}

interface ImportedName {
  file: string
  name: string
  rest: readonly string[]
}

interface ImportedNames {
  names: ImportedName[]
  renamed: boolean
}

function importedNamesOf(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
): ImportedNames {
  const names: ImportedName[] = []
  let renamed = false
  for (const edge of ctx.imports) {
    if (edge.dynamic) continue

    if (edge.symbols === "*") {
      if (edge.namespaceBinding !== head) continue
      renamed = true
      const [first, ...rest] = tail
      const file = importTargetOf(ctx, edge)
      if (first !== undefined && file !== null) names.push({ file, name: first, rest })
      continue
    }

    for (const raw of edge.symbols) {
      const { imported, local } = splitAliasedImportName(raw)
      if (local !== head) continue
      if (imported !== local) renamed = true
      const file = importTargetOf(ctx, edge)
      if (file !== null) names.push({ file, name: imported, rest: tail })
    }
  }
  return { names, renamed }
}

function importTargetOf(ctx: ResolveTargetContext, edge: ImportEdge): string | null {
  return specifierTargetOf(ctx.run, ctx.caller.language, ctx.caller.source.file, edge.source)
}

function specifierTargetOf(
  run: ResolutionRun,
  language: string,
  fromFile: string,
  specifier: string,
): string | null {
  return isRelativeSpecifier(specifier)
    ? relativeTargetOf(run, language, fromFile, specifier)
    : mappedTargetOf(run, language, fromFile, specifier)
}

/**
 * Where a module's export of a name is declared: in the module, or where its re-exports lead.
 * `declared` holds one site, or several where star exports disagree; `namespace` is a module
 * exported whole under the name; `outside` is a chain that left the workspace.
 */
export type ExportAnswer =
  | { readonly kind: "declared"; readonly sites: readonly ExportSite[] }
  | { readonly kind: "namespace"; readonly file: string }
  | { readonly kind: "outside" }
  | { readonly kind: "none" }

interface ExportSite {
  readonly file: string
  readonly name: string
}

const NO_ANSWER: ExportAnswer = { kind: "none" }
const OUTSIDE: ExportAnswer = { kind: "outside" }

/** The declarations an imported name reaches through its module's re-exports. */
function declarationsOf(
  ctx: ResolveTargetContext,
  entry: ImportedName,
  trace: ResolutionTrace,
): ImportedName[] {
  let { file, name, rest } = entry
  for (;;) {
    const answer = exportAnswerOf(ctx.run, ctx.caller.language, file, name)
    switch (answer.kind) {
      case "declared":
        return answer.sites.map((site) => ({ file: site.file, name: site.name, rest }))
      case "outside":
        trace.reexportedFromOutside = true
        return []
      case "none":
        return name === DEFAULT_EXPORT_NAME ? [] : [{ file, name, rest }]
      case "namespace": {
        const [member, ...more] = rest
        if (member === undefined) return []
        file = answer.file
        name = member
        rest = more
      }
    }
  }
}

function exportAnswerOf(
  run: ResolutionRun,
  language: string,
  file: string,
  name: string,
): ExportAnswer {
  return answerExport(run, language, file, name, new Set()).answer
}

interface Answered {
  readonly answer: ExportAnswer
  /** False when a cycle cut the search short, so the answer holds for this search alone. */
  readonly whole: boolean
}

function answerExport(
  run: ResolutionRun,
  language: string,
  file: string,
  name: string,
  asking: Set<string>,
): Answered {
  // Neither a language id nor a path holds NUL, and the name comes last: the key splits one way.
  const key = `${language}\0${file}\0${name}`
  const cached = run.exportAnswers.get(key)
  if (cached !== undefined) return { answer: cached, whole: true }
  if (asking.has(key)) return { answer: NO_ANSWER, whole: false }
  asking.add(key)
  const answered = searchExport(run, language, file, name, asking)
  asking.delete(key)
  if (answered.whole) run.exportAnswers.set(key, answered.answer)
  return answered
}

function searchExport(
  run: ResolutionRun,
  language: string,
  file: string,
  name: string,
  asking: Set<string>,
): Answered {
  const declared = declaredExport(run.table, file, name)
  if (declared !== null) return { answer: declared, whole: true }
  const edges = (run.importsByFile.get(file) ?? []).filter((edge) => !edge.dynamic)
  for (const edge of edges) {
    const reexport = edge.reexports?.find((entry) => entry.exported === name)
    if (reexport === undefined) continue
    const target = specifierTargetOf(run, language, file, edge.source)
    if (target === null) {
      return { answer: isRelativeSpecifier(edge.source) ? NO_ANSWER : OUTSIDE, whole: true }
    }
    if (reexport.imported === NAMESPACE_EXPORT) {
      return { answer: { kind: "namespace", file: target }, whole: true }
    }
    return answerExport(run, language, target, reexport.imported, asking)
  }
  if (name === DEFAULT_EXPORT_NAME) return { answer: NO_ANSWER, whole: true }
  return starExport(run, language, file, name, edges, asking)
}

function starExport(
  run: ResolutionRun,
  language: string,
  file: string,
  name: string,
  edges: readonly ImportEdge[],
  asking: Set<string>,
): Answered {
  const found: ExportAnswer[] = []
  let outside = false
  let whole = true
  for (const edge of edges) {
    if (edge.reexportsAll !== true) continue
    const target = specifierTargetOf(run, language, file, edge.source)
    if (target === null) {
      outside ||= !isRelativeSpecifier(edge.source)
      continue
    }
    const answered = answerExport(run, language, target, name, asking)
    whole &&= answered.whole
    if (answered.answer.kind === "outside") outside = true
    else if (answered.answer.kind !== "none") found.push(answered.answer)
  }
  const [only, ...others] = distinctAnswers(found)
  if (only === undefined) return { answer: outside ? OUTSIDE : NO_ANSWER, whole }
  if (others.length === 0) return { answer: only, whole }
  const sites = [only, ...others].flatMap((answer) =>
    answer.kind === "declared" ? answer.sites : [],
  )
  return { answer: { kind: "declared", sites }, whole }
}

// Two star exports of one module, or of two barrels over it, agree.
function distinctAnswers(answers: readonly ExportAnswer[]): ExportAnswer[] {
  const byKey = new Map<string, ExportAnswer>()
  for (const answer of answers) {
    const key =
      answer.kind === "declared"
        ? answer.sites.map((site) => `${site.file}\0${site.name}`).join("\n")
        : answer.kind === "namespace"
          ? `*\0${answer.file}`
          : answer.kind
    if (!byKey.has(key)) byKey.set(key, answer)
  }
  return [...byKey.values()]
}

const NAMESPACE_EXPORT = "*"

function declaredExport(table: SymbolTable, file: string, name: string): ExportAnswer | null {
  if (name === DEFAULT_EXPORT_NAME) {
    const names = defaultExportsOf(table, file)
    return names.length === 0
      ? null
      : { kind: "declared", sites: names.map((declared) => ({ file, name: declared })) }
  }
  const declares =
    table.topLevelByFile.get(file)?.has(name) === true ||
    table.memberOwnersByFile.get(file)?.has(name) === true
  return declares ? { kind: "declared", sites: [{ file, name }] } : null
}

const NO_FILES: ReadonlySet<string> = new Set()

/** The first path a file's language maps a bare specifier to that is a file the scan read. */
export function mappedTargetOf(
  run: ResolutionRun,
  language: string,
  fromFile: string,
  specifier: string,
): string | null {
  const paths = run.specifierPaths.get(fromFile)?.get(specifier)
  if (paths === undefined) return null
  const key = `${language}\0${fromFile}\0${specifier}`
  const cached = run.mappedTargets.get(key)
  if (cached !== undefined) return cached
  const knownFiles = run.table.filesByLanguage.get(language) ?? NO_FILES
  let resolved: string | null = null
  for (const path of paths) {
    resolved = resolveRelativeSpecifier({
      fromDirectory: "",
      specifier: path,
      extensions: run.extensions,
      knownFiles,
    })
    if (resolved !== null) break
  }
  run.mappedTargets.set(key, resolved)
  return resolved
}

function defaultExportsOf(table: SymbolTable, file: string): string[] {
  const found: string[] = []
  for (const bucket of table.topLevelByFile.get(file)?.values() ?? []) {
    for (const symbol of bucket) {
      if (
        symbol.name === DEFAULT_EXPORT_QNAME ||
        symbol.derivedBy.includes(EXPORT_DEFAULT_DERIVED_BY)
      ) {
        found.push(symbol.name)
      }
    }
  }
  return found
}

function relativeTargetOf(
  run: ResolutionRun,
  language: string,
  fromFile: string,
  specifier: string,
): string | null {
  const fromDirectory = dirname(fromFile)
  // Neither a language id nor a path holds NUL and the specifier comes last: the key splits one way.
  const key = `${language}\0${fromDirectory}\0${specifier}`
  const cached = run.relativeTargets.get(key)
  if (cached !== undefined) return cached
  const knownFiles = run.table.filesByLanguage.get(language)
  const resolved =
    knownFiles === undefined
      ? null
      : resolveRelativeSpecifier({
          fromDirectory,
          specifier,
          extensions: run.extensions,
          knownFiles,
        })
  run.relativeTargets.set(key, resolved)
  return resolved
}

function resolveInComponentScope(
  ctx: ResolveTargetContext,
  trace: ResolutionTrace,
): ResolutionHit | null {
  const perComponent = ctx.run.table.byComponent
    .get(ctx.caller.language)
    ?.get(componentKeyOf(ctx.caller.component))
  const hit = soleCandidate(perComponent?.get(ctx.target), trace)
  return hit === null ? null : { id: hit.id, confidence: "medium" }
}

function resolveInWorkspaceScope(
  ctx: ResolveTargetContext,
  trace: ResolutionTrace,
): ResolutionHit | null {
  const perName = ctx.run.table.byWorkspace.get(ctx.caller.language)
  const hit = soleCandidate(perName?.get(ctx.target), trace)
  return hit === null ? null : { id: hit.id, confidence: "low" }
}

function soleCandidate(
  bucket: readonly IRSymbol[] | undefined,
  trace: ResolutionTrace,
): IRSymbol | null {
  if (bucket === undefined) return null
  if (bucket.length !== 1) {
    for (const symbol of bucket) trace.ambiguousCandidates.add(symbol.id)
    return null
  }
  return bucket[0] ?? null
}

export function splitTargetSegments(target: string): string[] {
  return target.split(".").filter((s) => s.length > 0)
}

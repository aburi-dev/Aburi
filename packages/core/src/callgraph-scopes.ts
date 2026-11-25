import {
  CALL_ARGUMENT_FUNCTION_DERIVED_BY,
  type Confidence,
  EXPORT_DEFAULT_DERIVED_BY,
  FIELD_ASSIGNED_FUNCTION_DERIVED_BY,
  type ImportEdge,
  type Symbol as IRSymbol,
  type SymbolId,
} from "@aburi/types"
import type { ClassHeritages, ValueTypes } from "./call-site"
import { componentKeyOf, type SymbolTable } from "./callgraph-index"
import { dirname, isRelativeSpecifier, resolveRelativeSpecifier } from "./callgraph-specifier"
import { packageName } from "./component-manifest"
import { DEFAULT_EXPORT_QNAME, trySymbolId } from "./id"
import { DEFAULT_EXPORT_NAME, importBindsLocal, splitAliasedImportName } from "./import-edge"

export interface ResolutionTrace {
  ambiguousCandidates: Set<SymbolId>
  /** A parameter, or a name the language marks a scope inside the module as binding, is the head. */
  localShadow: boolean
  unnamedReceiver: boolean
  /** A re-export the head's import leads through names a bare specifier outside the workspace. */
  reexportedFromOutside: boolean
  /** The head's import reaches a name its module's star exports disagree on. */
  conflictingExport: boolean
  /**
   * The bare specifier of the package whose export ended the search, where component or
   * workspace scope holds a Symbol the target spells.
   */
  foreignNamesake: string | null
}

export function newTrace(): ResolutionTrace {
  return {
    ambiguousCandidates: new Set(),
    localShadow: false,
    unnamedReceiver: false,
    reexportedFromOutside: false,
    conflictingExport: false,
    foreignNamesake: null,
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
  /** The `package.json` names of the workspace's packages, private ones included. */
  workspacePackageNames: ReadonlySet<string>
  mappedTargets: Map<string, string | null>
  /** Every file's import edges, which say what a module re-exports. */
  importsByFile: ReadonlyMap<string, readonly ImportEdge[]>
  /** By language, file and name: where a module's export of the name is declared. */
  exportAnswers: Map<string, ExportAnswer>
  classHeritages: ClassHeritages
  valueTypes: ValueTypes
}

export interface ResolveTargetContext {
  run: ResolutionRun
  caller: IRSymbol
  target: string
  imports: readonly ImportEdge[]
  parameterNames: ReadonlySet<string>
  /** The language marks a scope nearer the call than the module as binding the target's head. */
  localHead?: boolean
  /** The Symbols a binding may reach: the kept ones unless a caller says otherwise. */
  reachable?: { has(id: SymbolId): boolean }
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

  if (ctx.localHead === true || ctx.parameterNames.has(head)) {
    trace.localShadow = true
    return null
  }

  if (head === "this" || head === "super") {
    trace.unnamedReceiver = true
    return null
  }

  // Component and workspace scope match the whole target by spelling, so past the declaration a
  // head is bound to they could only find a namesake.
  const bound = resolveBoundHead(ctx, head, tail, trace)
  if (bound?.foreign !== undefined && tail.length > 0 && hasNamesake(ctx)) {
    trace.foreignNamesake = bound.foreign
  }
  if (bound !== null) return bound.hit
  if (tail.length === 0) return null
  return resolveInComponentScope(ctx, trace) ?? resolveInWorkspaceScope(ctx, trace)
}

export function resolveThroughDeclaredType(
  ctx: ResolveTargetContext,
  type: string,
): ResolutionHit | null {
  const segments = splitTargetSegments(ctx.target)
  if (segments[0] === "super") return resolveThroughSuper(ctx, type, segments)
  return resolveThroughValueOf(ctx, boundClass(ctx, type))
}

export function resolveThroughImportedValue(ctx: ResolveTargetContext): ResolutionHit | null {
  return resolveThroughValueOf(ctx, importedValueClassOf(ctx))
}

// A language plugin reads one file at a time, so it types no call through a variable another module
// declares: that module's declaration gives the type, its name bound there.
export function importedValueClassOf(ctx: ResolveTargetContext): IRSymbol | null {
  if (ctx.run.valueTypes.size === 0) return null
  const segments = splitTargetSegments(ctx.target)
  const [head, ...rest] = segments.slice(0, -1)
  if (head === undefined) return null
  const reach = { ...ctx, reachable: ctx.run.table.allById }
  const id = resolveInImportScope(reach, head, rest, newTrace())?.hit?.id
  const variable = id === undefined ? undefined : ctx.run.table.allById.get(id)
  const type = id === undefined ? undefined : ctx.run.valueTypes.get(id)
  if (variable === undefined || type === undefined) return null
  return boundClassWhere(ctx.run, variable, type)
}

// A value of the class, or of a subclass whose override may run instead, reaches the member the
// class declares or inherits.
export function resolveThroughValueOf(
  ctx: ResolveTargetContext,
  owner: IRSymbol | null,
): ResolutionHit | null {
  const segments = splitTargetSegments(ctx.target)
  const member = segments.at(-1)
  if (segments.length < 2 || member === undefined) return null
  return instanceMemberOf(ctx.run, owner, member)
}

// A variable naming a function is read where it is declared, whatever a drop rule removed.
export function resolveReference(
  run: ResolutionRun,
  variable: IRSymbol,
  reference: string,
): ResolutionHit | null {
  const ctx = {
    run,
    caller: variable,
    target: reference,
    imports: run.importsByFile.get(variable.source.file) ?? [],
    parameterNames: EMPTY_NAME_SET,
    reachable: run.table.allById,
  }
  return resolveTarget(ctx, newTrace())
}

function instanceMemberOf(
  run: ResolutionRun,
  type: IRSymbol | null,
  member: string,
): ResolutionHit | null {
  for (const owner of classChain(run, type)) {
    const id = instanceMemberId(owner, member)
    if (id === null) return null
    // The value may be a subclass's, whose override then runs.
    if (run.table.keptSymbolIds.has(id)) return { id, confidence: "medium" }
    if (declaresMember(run, owner, member) || run.table.allById.has(id)) return null
  }
  return null
}

// `super` names the class the caller's class extends, which no subclass replaces: `super(…)`
// constructs it, and `super.<member>` reads its prototype, where a field is not.
function resolveThroughSuper(
  ctx: ResolveTargetContext,
  type: string,
  segments: readonly string[],
): ResolutionHit | null {
  const extended = boundClass(ctx, type)
  if (segments.length === 1) {
    return extended !== null && ctx.run.table.keptSymbolIds.has(extended.id)
      ? { id: extended.id, confidence: "high" }
      : null
  }
  const member = segments[1]
  if (segments.length !== 2 || member === undefined) return null
  for (const owner of classChain(ctx.run, extended)) {
    const id = instanceMemberId(owner, member)
    if (id === null) return null
    const declared = ctx.run.table.allById.get(id)
    if (declared === undefined) {
      if (declaresMember(ctx.run, owner, member)) return null
      continue
    }
    if (isHeldByField(declared) || !ctx.run.table.keptSymbolIds.has(id)) return null
    return { id, confidence: "high" }
  }
  return null
}

// A cycle of classes extending one another ends the chain where it would come round again.
function* classChain(run: ResolutionRun, first: IRSymbol | null): Iterable<IRSymbol> {
  const seen = new Set<SymbolId>()
  for (let owner = first; owner !== null; owner = superclassOf(run, owner)) {
    if (seen.has(owner.id)) return
    seen.add(owner.id)
    yield owner
  }
}

function instanceMemberId(owner: IRSymbol, member: string): SymbolId | null {
  return trySymbolId({
    language: owner.language,
    file: owner.source.file,
    qualifiedName: `${owner.name}.${member}`,
  })
}

// A member the class declares hides the one it inherits, though a drop rule removed it or, as a
// field holding data, it is no Symbol at all.
function declaresMember(run: ResolutionRun, owner: IRSymbol, member: string): boolean {
  return run.classHeritages.get(owner.id)?.instanceMembers.includes(member) === true
}

function isHeldByField(member: IRSymbol): boolean {
  return member.derivedBy.some(
    (token) =>
      token === FIELD_ASSIGNED_FUNCTION_DERIVED_BY || token === CALL_ARGUMENT_FUNCTION_DERIVED_BY,
  )
}

// Not component or workspace scope: matching a type by its spelling could only find a namesake. A
// drop rule keeps a class out of `resolved`, not out of what its name means or what it inherits.
export function boundClass(ctx: ResolveTargetContext, type: string): IRSymbol | null {
  const [head, ...tail] = splitTargetSegments(type)
  if (head === undefined) return null
  const typeCtx = { ...ctx, target: type, reachable: ctx.run.table.allById }
  const bound = resolveBoundHead(typeCtx, head, tail, newTrace())
  const owner = bound?.hit == null ? undefined : ctx.run.table.allById.get(bound.hit.id)
  return owner?.kind === "class" ? owner : null
}

// The class's own file binds the name it extends, by its declarations and its imports.
function superclassOf(run: ResolutionRun, owner: IRSymbol): IRSymbol | null {
  const superclass = run.classHeritages.get(owner.id)?.superclass
  return superclass === undefined ? null : boundClassWhere(run, owner, superclass)
}

export function boundClassWhere(
  run: ResolutionRun,
  declaration: IRSymbol,
  type: string,
): IRSymbol | null {
  return boundClass(
    {
      run,
      caller: declaration,
      target: type,
      imports: run.importsByFile.get(declaration.source.file) ?? [],
      parameterNames: EMPTY_NAME_SET,
    },
    type,
  )
}

interface BoundHead {
  hit: ResolutionHit | null
  /**
   * The bare specifier of the package the head is an export of, which component and workspace
   * scope could find only a namesake of.
   */
  foreign?: string
}

const NO_MEMBER: BoundHead = { hit: null }

// `const { x } = require("./m")` declares `x` only as the import's alias, so the import answers
// first. An import on another line, like `import type { X }` beside `const X`, binds the type
// alone, so file scope stays first.
function resolveBoundHead(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
  trace: ResolutionTrace,
): BoundHead | null {
  if (!declaredByItsImport(ctx, head)) {
    return (
      resolveInFileScope(ctx, head, tail, trace) ?? resolveInImportScope(ctx, head, tail, trace)
    )
  }
  const imported = resolveInImportScope(ctx, head, tail, trace)
  if (imported?.hit != null) return imported
  // What `require()` gives back is `module.exports`, whose members its module need not declare at
  // its top level, so a member the import does not find in a workspace module is left to the
  // later scopes. A package's export has no namesake there to find.
  const declared = resolveInFileScope(ctx, head, tail, trace)
  return imported?.foreign === undefined ? declared : (declared ?? imported)
}

function declaredByItsImport(ctx: ResolveTargetContext, head: string): boolean {
  const declared = ctx.run.table.topLevelByFile.get(ctx.caller.source.file)?.get(head)
  if (declared === undefined) return false
  return ctx.imports.some(
    (edge) =>
      importBindsLocal(edge, head) &&
      declared.some(({ source }) => source.startLine <= edge.line && edge.line <= source.endLine),
  )
}

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
  const reachable = ctx.reachable ?? ctx.run.table.keptSymbolIds
  const keptId = (qualifiedName: string) => {
    const id = trySymbolId({ language: ctx.caller.language, file, qualifiedName })
    return id !== null && reachable.has(id) ? id : null
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
  let conflicting = false
  const names = imported.names.flatMap((entry) => {
    const reached = declarationsOf(ctx, entry, trace)
    if (reached === null) conflicting = true
    return reached ?? []
  })
  if (imported.foreign !== null) return { hit: null, foreign: imported.foreign }
  // A member only some of the disagreeing declarations hold would otherwise pick one of them.
  if (conflicting) return NO_MEMBER
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
  /**
   * A bare specifier that reaches no file the scan read and names no workspace package, so the head
   * is a package's export, whatever the workspace declares under the same name.
   */
  foreign: string | null
}

function importedNamesOf(
  ctx: ResolveTargetContext,
  head: string,
  tail: readonly string[],
): ImportedNames {
  const names: ImportedName[] = []
  let renamed = false
  let foreign: string | null = null
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
      else if (foreign === null && isForeignSpecifier(ctx.run, edge.source)) foreign = edge.source
    }
  }
  return { names, renamed, foreign }
}

// A workspace package whose manifest names only files the scan did not read, such as built output,
// is still the workspace's, and its Symbols are found by name. That the language maps a specifier
// says nothing of whose it is, since `baseUrl` maps every bare specifier.
function isForeignSpecifier(run: ResolutionRun, specifier: string): boolean {
  if (isRelativeSpecifier(specifier)) return false
  const name = packageName(specifier)
  return name !== null && !run.workspacePackageNames.has(name)
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
 * `declared` holds one site, or each default export of a module declaring several; `conflict`
 * holds the declarations star exports disagree on; `namespace` is a module exported whole under
 * the name; `outside` is a chain that left the workspace.
 */
export type ExportAnswer =
  | { readonly kind: "declared"; readonly sites: readonly ExportSite[] }
  | { readonly kind: "conflict"; readonly sites: readonly ExportSite[] }
  | { readonly kind: "namespace"; readonly file: string }
  | { readonly kind: "outside" }
  | { readonly kind: "none" }

interface ExportSite {
  readonly file: string
  readonly name: string
}

const NO_ANSWER: ExportAnswer = { kind: "none" }
const OUTSIDE: ExportAnswer = { kind: "outside" }

/**
 * The declarations an imported name reaches through its module's re-exports, or null where star
 * exports disagree on it, whose declarations go to the trace.
 */
function declarationsOf(
  ctx: ResolveTargetContext,
  entry: ImportedName,
  trace: ResolutionTrace,
): ImportedName[] | null {
  let { file, name, rest } = entry
  for (;;) {
    const answer = exportAnswerOf(ctx.run, ctx.caller.language, file, name)
    switch (answer.kind) {
      case "declared":
        return answer.sites.map((site) => ({ file: site.file, name: site.name, rest }))
      case "conflict":
        trace.conflictingExport = true
        for (const site of answer.sites) {
          const id = memberId(ctx, site.file, site.name, [])
          if (id !== null) trace.ambiguousCandidates.add(id)
        }
        return null
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
  visited: Set<string>,
): Answered {
  // Neither a language id nor a path holds NUL, and the name comes last: the key splits one way.
  const key = `${language}\0${file}\0${name}`
  const cached = run.exportAnswers.get(key)
  if (cached !== undefined) return { answer: cached, whole: true }
  // What a revisit could find, the first visit found and handed up to the search's answer, so
  // each module and name is asked once per search however many paths lead to it.
  if (visited.has(key)) return { answer: NO_ANSWER, whole: false }
  visited.add(key)
  const answered = searchExport(run, language, file, name, visited)
  if (answered.whole) run.exportAnswers.set(key, answered.answer)
  return answered
}

function searchExport(
  run: ResolutionRun,
  language: string,
  file: string,
  name: string,
  visited: Set<string>,
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
    return answerExport(run, language, target, reexport.imported, visited)
  }
  if (name === DEFAULT_EXPORT_NAME) return { answer: NO_ANSWER, whole: true }
  return starExport(run, language, file, name, edges, visited)
}

function starExport(
  run: ResolutionRun,
  language: string,
  file: string,
  name: string,
  edges: readonly ImportEdge[],
  visited: Set<string>,
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
    const answered = answerExport(run, language, target, name, visited)
    whole &&= answered.whole
    if (answered.answer.kind === "outside") outside = true
    else if (answered.answer.kind !== "none") found.push(answered.answer)
  }
  const [only, ...others] = distinctAnswers(found)
  if (only === undefined) return { answer: outside ? OUTSIDE : NO_ANSWER, whole }
  if (others.length === 0) return { answer: only, whole }
  const sites = [only, ...others].flatMap((answer) => ("sites" in answer ? answer.sites : []))
  return { answer: { kind: "conflict", sites }, whole }
}

// Two star exports of one module, or of two barrels over it, agree.
function distinctAnswers(answers: readonly ExportAnswer[]): ExportAnswer[] {
  const byKey = new Map<string, ExportAnswer>()
  for (const answer of answers) {
    const key =
      "sites" in answer
        ? `${answer.kind}\0${answer.sites.map((site) => `${site.file}\0${site.name}`).join("\n")}`
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
  // `export { stringType as string }` exports the declaration under the clause's name, which a
  // declaration of that name, if the module has one, does not then hold.
  const aliased = table.clauseExportsByFile.get(file)?.get(name)
  if (aliased !== undefined) {
    return { kind: "declared", sites: aliased.map((declared) => ({ file, name: declared })) }
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

function hasNamesake(ctx: ResolveTargetContext): boolean {
  return (ctx.run.table.byWorkspace.get(ctx.caller.language)?.get(ctx.target)?.length ?? 0) > 0
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

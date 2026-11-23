import type {
  CallCandidate,
  ExtractionContext,
  ImportEdge,
  ImportResolver,
  LanguagePlugin,
  OpaqueAstNode,
  SourceFile,
  SymbolCandidate,
} from "@aburi/types"
import { AsyncMemo } from "../async-memo"
import {
  DEFAULT_EXTENSIONS,
  dirname,
  isRelativeSpecifier,
  resolveRelativeSpecifier,
} from "../callgraph-specifier"
import { toNfc } from "../codepoints"
import { packageName, type WorkspacePackage } from "../component-manifest"
import { DEFAULT_EXPORT_NAME, decoratorReference, splitAliasedImportName } from "../import-edge"
import { compareCodeUnit } from "../order"
import type { DiscoveredFile } from "./discover"
import {
  type ExtractionEvent,
  edgesReadOnce,
  eventLogger,
  resolverCreatedOnce,
  targetResolvedOnce,
} from "./extraction-events"
import { describeJsonType, describeThrown } from "./faults"
import { normalizeCandidates, normalizeImportEdge } from "./normalize"
import { packageEntryPaths } from "./package-entry"
import { releaseParsedTree, type TreeReleaseFailure } from "./pipeline"
import type { LanguageRouter } from "./route"

type Language = LanguagePlugin<unknown, unknown>

export interface ImportOriginsInput {
  workspaceRoot: string
  installedRoot?: string
  files: readonly DiscoveredFile[]
  workspacePackages: readonly WorkspacePackage[]
  router: LanguageRouter
  loadSource(file: DiscoveredFile): Promise<SourceFile>
  record(event: ExtractionEvent): void
}

interface Hop {
  readonly source: string
  readonly imported: string
}

function packagesByName(
  packages: readonly WorkspacePackage[],
): ReadonlyMap<string, WorkspacePackage | null> {
  const byName = new Map<string, WorkspacePackage | null>()
  for (const pkg of packages) byName.set(pkg.name, byName.has(pkg.name) ? null : pkg)
  return byName
}

/** Where a specifier leads: a workspace file, out of the workspace, or nowhere the resolver could say. */
type Target = { readonly file: string } | "outside" | "fault"

/** What a name an edge binds leads to: see `ImportEdge.upstream` and `ImportEdge.origins`. */
interface Upstream {
  readonly sources: readonly string[]
  readonly origin: string | null
}

/** A class a module declares: the members it declares itself and the name its `extends` writes. */
export interface DeclaredClass {
  readonly members: ReadonlySet<string>
  readonly superclass: string | undefined
}

/** The classes a module declares at its top level, by name. */
export type DeclaredClasses = ReadonlyMap<string, DeclaredClass>

/** What reading another module's classes takes from the file being extracted. */
export type ClassReadContext = Pick<ExtractionContext, "registry" | "config">

/** A bare specifier a file imports through and the paths its language maps it to, in order. */
export type SpecifierPaths = readonly [specifier: string, paths: readonly string[]]

const NAMESPACE = "*"

// A module another file leads to is parsed once per thread, so an effect plugin's gate and a
// decorator's origin cost one parse of each module the workspace imports from.
export class ImportOrigins {
  readonly #input: ImportOriginsInput
  readonly #files: ReadonlyMap<string, DiscoveredFile>
  readonly #knownFiles: ReadonlySet<string>
  /** By name; null for a name several manifests share, which leaves no way to tell them apart. */
  readonly #workspacePackages: ReadonlyMap<string, WorkspacePackage | null>
  readonly #resolvers = new Map<Language, ImportResolver | "none" | "fault">()
  readonly #edges = new AsyncMemo<string, readonly ImportEdge[]>()
  readonly #targets = new AsyncMemo<string, Target>()
  readonly #mapped = new AsyncMemo<string, readonly string[] | "fault">()
  readonly #sources = new Map<string, readonly string[]>()
  readonly #upstreamTargets = new AsyncMemo<string, Target>()
  readonly #classes = new AsyncMemo<string, DeclaredClasses>()

  constructor(input: ImportOriginsInput) {
    this.#input = input
    this.#files = new Map(input.files.map((file) => [file.path, file]))
    this.#knownFiles = new Set(this.#files.keys())
    this.#workspacePackages = packagesByName(input.workspacePackages)
  }

  remember(path: string, edges: readonly ImportEdge[]): void {
    this.#edges.prime(path, edges)
  }

  rememberClasses(path: string, classes: DeclaredClasses): void {
    this.#classes.prime(path, classes)
  }

  async attach(
    file: SourceFile,
    imports: readonly ImportEdge[],
    candidates: readonly SymbolCandidate<OpaqueAstNode>[],
  ): Promise<readonly ImportEdge[]> {
    const originsByEdge = new Map<ImportEdge, Map<string, string>>()
    for (const [edge, names] of decoratorBindings(imports, candidates)) {
      const origins = new Map<string, string>()
      for (const name of names) {
        const origin = await this.#externalOrigin(file.path, edge.source, name)
        if (origin !== null) origins.set(name, origin)
      }
      if (origins.size > 0) originsByEdge.set(edge, origins)
    }
    if (originsByEdge.size === 0) return imports
    return imports.map((edge) => {
      const origins = originsByEdge.get(edge)
      return origins === undefined ? edge : { ...edge, origins }
    })
  }

  /**
   * The edges with `upstream` set on each that binds names from a workspace file: for each name,
   * what the last workspace module on its chain imports, and its origin where the chain ends at a
   * package outside the workspace.
   */
  async attachUpstream(
    fromFile: string,
    imports: readonly ImportEdge[],
  ): Promise<readonly ImportEdge[]> {
    let attached: ImportEdge[] | null = null
    for (const [index, edge] of imports.entries()) {
      const upstream = new Map<string, readonly string[]>()
      let origins: Map<string, string> | null = null
      for (const name of boundNames(edge)) {
        const followed = await this.#upstreamOf(fromFile, edge.source, name)
        if (followed === null) continue
        upstream.set(name, followed.sources)
        if (followed.origin === null) continue
        origins ??= new Map(edge.origins ?? [])
        origins.set(name, followed.origin)
      }
      if (upstream.size === 0) continue
      attached ??= [...imports]
      attached[index] = origins === null ? { ...edge, upstream } : { ...edge, upstream, origins }
    }
    return attached ?? imports
  }

  /**
   * The calls whose receiver is declared with a class the workspace declares the called member on,
   * itself or through the classes it extends there: the class's own method, which call resolution
   * takes. A class the file declares is read from `classes`, one it imports from the module that
   * declares it.
   */
  async callsOnWorkspaceMembers(
    fromFile: string,
    imports: readonly ImportEdge[],
    classes: DeclaredClasses,
    calls: readonly CallCandidate[],
    ctx: ClassReadContext,
  ): Promise<ReadonlySet<CallCandidate>> {
    const found = new Set<CallCandidate>()
    for (const call of calls) {
      const type = call.receiverType
      if (typeof type !== "string" || type.length === 0) continue
      const member = call.target.slice(call.target.lastIndexOf(".") + 1)
      const declares = await this.#declaresMember(
        { file: fromFile, edges: imports, classes },
        toNfc(type),
        toNfc(member),
        ctx,
        new Set(),
      )
      if (declares) found.add(call)
    }
    return found
  }

  async #declaresMember(
    module: ClassModule,
    type: string,
    member: string,
    ctx: ClassReadContext,
    visited: Set<string>,
  ): Promise<boolean> {
    const state = `${module.file}\0${type}\0extends`
    if (visited.has(state)) return false
    visited.add(state)
    const declared = await this.#classNamed(module, type, ctx, visited)
    if (declared === null) return false
    if (declared.shape.members.has(member)) return true
    const superclass = declared.shape.superclass
    if (superclass === undefined) return false
    return this.#declaresMember(declared.module, superclass, member, ctx, visited)
  }

  // The class a name the module binds is: its own, or the one an import of it leads to.
  async #classNamed(
    module: ClassModule,
    name: string,
    ctx: ClassReadContext,
    visited: Set<string>,
  ): Promise<{ readonly module: ClassModule; readonly shape: DeclaredClass } | null> {
    const own = module.classes.get(name)
    if (own !== undefined) return { module, shape: own }
    const hop = importedAs(module.edges, name)
    if (hop === null) return null
    const target = await this.#upstreamTarget(module.file, hop.source)
    if (typeof target !== "object") return null
    return this.#exportedClass(target.file, hop.imported, ctx, visited)
  }

  async #exportedClass(
    file: string,
    name: string,
    ctx: ClassReadContext,
    visited: Set<string>,
  ): Promise<{ readonly module: ClassModule; readonly shape: DeclaredClass } | null> {
    const state = `${file}\0${name}`
    if (visited.has(state)) return null
    visited.add(state)
    const classes = await this.#classes.get(file, () => this.#readClasses(file, ctx))
    const edges = await this.#edges.get(file, () => this.#readEdges(file))
    const module: ClassModule = { file, edges, classes }
    const own = classes.get(name)
    if (own !== undefined) return { module, shape: own }
    const hop = reexportOf(edges, name)
    if (hop !== null) {
      if (hop.imported === NAMESPACE) return null
      const target = await this.#upstreamTarget(file, hop.source)
      return typeof target === "object"
        ? this.#exportedClass(target.file, hop.imported, ctx, visited)
        : null
    }
    if (name === DEFAULT_EXPORT_NAME) return null
    for (const edge of edges) {
      if (edge.reexportsAll !== true) continue
      const target = await this.#upstreamTarget(file, edge.source)
      if (typeof target !== "object") continue
      const reached = await this.#exportedClass(target.file, name, ctx, visited)
      if (reached !== null) return reached
    }
    return null
  }

  async #readClasses(path: string, ctx: ClassReadContext): Promise<DeclaredClasses> {
    const discovered = this.#files.get(path)
    const language = this.#input.router.route(path)
    if (discovered === undefined || language === null) return NO_CLASSES
    const once = edgesReadOnce(path)
    try {
      const file = await this.#input.loadSource(discovered)
      const parsed = await language.parseFile(file)
      this.#edges.prime(path, parsed.imports.map(normalizeImportEdge))
      if (parsed.tree === null) return NO_CLASSES
      try {
        const candidates = normalizeCandidates(
          language.extractSymbols(parsed.tree, { file, ...ctx }),
          language.manifest.name,
        )
        return Array.isArray(candidates) ? declaredClasses(candidates) : NO_CLASSES
      } finally {
        const failures: TreeReleaseFailure[] = []
        releaseParsedTree(language, parsed.tree, file, failures)
        for (const failure of failures) {
          this.#input.record({ kind: "tree-release-failure", failure, once })
        }
      }
    } catch (error) {
      // The file's own turn in the scan reports the fault; here it only ends the chain.
      this.#input.record({
        kind: "log",
        level: "debug",
        message: `scan/import-origins: ${path} gave no classes: ${describeThrown(error)}`,
        once,
      })
      return NO_CLASSES
    }
  }

  /** `null` where the edge's own module is outside the workspace, which its specifier says. */
  async #upstreamOf(fromFile: string, specifier: string, name: string): Promise<Upstream | null> {
    const first = await this.#upstreamTarget(fromFile, specifier)
    if (typeof first !== "object") return null
    return this.#declaringImports(first.file, name, new Set())
  }

  async #declaringImports(
    file: string,
    name: string,
    visited: Set<string>,
  ): Promise<Upstream | null> {
    const state = `${file}\0${name}`
    if (visited.has(state)) return null
    visited.add(state)
    const edges = await this.#edges.get(file, () => this.#readEdges(file))
    const own = this.#sourcesOf(file, edges)
    if (name !== NAMESPACE) {
      const hop = reexportOf(edges, name)
      if (hop !== null) {
        const target = await this.#upstreamTarget(file, hop.source)
        if (target === "fault") return null
        if (target === "outside") {
          return { sources: own, origin: this.#isForeign(hop.source) ? hop.source : null }
        }
        if (hop.imported === NAMESPACE) return { sources: own, origin: null }
        return this.#declaringImports(target.file, hop.imported, visited)
      }
    }
    // `export *` may be where the name comes from; what it leads to joins the module's own imports.
    const throughAll = new Set<string>()
    if (name !== NAMESPACE && name !== DEFAULT_EXPORT_NAME) {
      for (const edge of edges) {
        if (edge.reexportsAll !== true) continue
        const target = await this.#upstreamTarget(file, edge.source)
        if (typeof target !== "object") continue
        const reached = await this.#declaringImports(target.file, name, visited)
        for (const source of reached?.sources ?? []) throughAll.add(source)
      }
    }
    if (throughAll.size === 0) return { sources: own, origin: null }
    return { sources: [...new Set([...own, ...throughAll])].sort(compareCodeUnit), origin: null }
  }

  #sourcesOf(file: string, edges: readonly ImportEdge[]): readonly string[] {
    let sources = this.#sources.get(file)
    if (sources === undefined) {
      sources = [...new Set(edges.map((edge) => edge.source))].sort(compareCodeUnit)
      this.#sources.set(file, sources)
    }
    return sources
  }

  // A workspace package's name leads into the package here, as call resolution follows it.
  #upstreamTarget(fromFile: string, specifier: string): Promise<Target> {
    return this.#upstreamTargets.get(`${fromFile}\0${specifier}`, async () => {
      const target = await this.#targets.get(`${fromFile}\0${specifier}`, () =>
        this.#resolveTarget(fromFile, specifier),
      )
      if (target !== "outside" || isRelativeSpecifier(specifier)) return target
      for (const path of this.#packagePaths(specifier)) {
        const found = this.#probe("", path)
        if (found !== null) return { file: found }
      }
      return target
    })
  }

  /**
   * What the file's language maps each bare specifier it imports names through to, then, for a
   * workspace package's name, the files its manifest names, which the language looks up last.
   */
  async mapSpecifiers(
    fromFile: string,
    imports: readonly ImportEdge[],
  ): Promise<readonly SpecifierPaths[]> {
    const out: SpecifierPaths[] = []
    const asked = new Set<string>()
    for (const { source, symbols, dynamic } of imports) {
      if (dynamic || isRelativeSpecifier(source) || asked.has(source)) continue
      if (symbols !== "*" && symbols.length === 0) continue
      asked.add(source)
      const mapped = await this.#mappedPaths(fromFile, source)
      const paths = [...(mapped === "fault" ? [] : mapped), ...this.#packagePaths(source)]
      if (paths.length > 0) out.push([source, paths])
    }
    return out
  }

  async #externalOrigin(fromFile: string, specifier: string, name: string): Promise<string | null> {
    const visited = new Set<string>()
    let hop: Hop = { source: specifier, imported: name }
    let from = fromFile
    for (;;) {
      const source = hop.source
      const key = `${from}\0${source}`
      const target = await this.#targets.get(key, () => this.#resolveTarget(from, source))
      if (target === "fault") return null
      if (target === "outside") return this.#isForeign(source) ? source : null
      // A namespace of a workspace module: which member the decorator reads is not carried here.
      if (hop.imported === NAMESPACE) return null
      const state = `${target.file}\0${hop.imported}`
      if (visited.has(state)) return null
      visited.add(state)
      const file = target.file
      const next = reexportOf(
        await this.#edges.get(file, () => this.#readEdges(file)),
        hop.imported,
      )
      if (next === null) return null
      from = file
      hop = next
    }
  }

  #packagePaths(specifier: string): readonly string[] {
    const name = packageName(specifier)
    const pkg = name === null ? null : this.#workspacePackages.get(name)
    return pkg == null ? [] : packageEntryPaths(pkg, specifier)
  }

  // An origin names a package outside the workspace, so a workspace package's name ends the chain.
  #isForeign(specifier: string): boolean {
    if (isRelativeSpecifier(specifier)) return false
    const name = packageName(specifier)
    return name !== null && !this.#workspacePackages.has(name)
  }

  async #resolveTarget(fromFile: string, specifier: string): Promise<Target> {
    if (isRelativeSpecifier(specifier)) return this.#fileOrOutside(dirname(fromFile), specifier)
    const paths = await this.#mappedPaths(fromFile, specifier)
    if (paths === "fault") return "fault"
    for (const path of paths) {
      const found = this.#probe("", path)
      if (found !== null) return { file: found }
    }
    return "outside"
  }

  #mappedPaths(fromFile: string, specifier: string): Promise<readonly string[] | "fault"> {
    return this.#mapped.get(`${fromFile}\0${specifier}`, async () => {
      const language = this.#input.router.route(fromFile)
      if (language === null) return []
      const resolver = this.#resolverFor(language)
      if (resolver === "none") return []
      if (resolver === "fault") return "fault"
      try {
        const paths: unknown = await resolver.resolve(specifier, fromFile)
        if (!Array.isArray(paths)) {
          throw new TypeError(`expected a list of paths, got ${describeJsonType(paths)}`)
        }
        return paths.filter((path): path is string => typeof path === "string").map(toNfc)
      } catch (error) {
        this.#fault(
          language,
          `its import resolver threw on "${specifier}" in ${fromFile}`,
          error,
          targetResolvedOnce(fromFile, specifier),
        )
        return "fault"
      }
    })
  }

  #fileOrOutside(fromDirectory: string, specifier: string): Target {
    const found = this.#probe(fromDirectory, specifier)
    return found === null ? "outside" : { file: found }
  }

  #resolverFor(language: Language): ImportResolver | "none" | "fault" {
    let resolver = this.#resolvers.get(language)
    if (resolver === undefined) {
      resolver = this.#createResolver(language)
      this.#resolvers.set(language, resolver)
    }
    return resolver
  }

  #createResolver(language: Language): ImportResolver | "none" | "fault" {
    if (typeof language.createImportResolver !== "function") return "none"
    const plugin = language.manifest.name
    const once = resolverCreatedOnce(plugin)
    let created: unknown
    try {
      created = language.createImportResolver({
        workspaceRoot: this.#input.workspaceRoot,
        ...(this.#input.installedRoot === undefined
          ? {}
          : { installedRoot: this.#input.installedRoot }),
        log: eventLogger((level, message, meta) =>
          this.#input.record({
            kind: "resolver-log",
            plugin,
            level,
            message,
            ...(meta === undefined ? {} : { meta }),
          }),
        ),
      })
    } catch (error) {
      this.#fault(language, "creating its import resolver threw", error, once)
      return "fault"
    }
    if (isImportResolver(created)) return created
    this.#fault(
      language,
      "createImportResolver returned no resolver",
      new TypeError(`expected an object with a resolve method, got ${describeJsonType(created)}`),
      once,
    )
    return "fault"
  }

  #probe(fromDirectory: string, specifier: string): string | null {
    return resolveRelativeSpecifier({
      fromDirectory,
      specifier,
      extensions: DEFAULT_EXTENSIONS,
      knownFiles: this.#knownFiles,
    })
  }

  async #readEdges(path: string): Promise<readonly ImportEdge[]> {
    const discovered = this.#files.get(path)
    const language = this.#input.router.route(path)
    if (discovered === undefined || language === null) return []
    const once = edgesReadOnce(path)
    try {
      const file = await this.#input.loadSource(discovered)
      const parsed = await language.parseFile(file)
      if (parsed.tree !== null) {
        const failures: TreeReleaseFailure[] = []
        releaseParsedTree(language, parsed.tree, file, failures)
        for (const failure of failures) {
          this.#input.record({ kind: "tree-release-failure", failure, once })
        }
      }
      return parsed.imports.map(normalizeImportEdge)
    } catch (error) {
      // The file's own turn in the scan reports the fault; here it only ends the chain.
      this.#input.record({
        kind: "log",
        level: "debug",
        message: `scan/import-origins: ${path} gave no import edges: ${describeThrown(error)}`,
        once,
      })
      return []
    }
  }

  #fault(language: Language, what: string, error: unknown, once: string): void {
    const plugin = language.manifest.name
    const message = `Plugin ${plugin}: ${what}: ${describeThrown(error)}.`
    this.#input.record({ kind: "resolver-fault", plugin, message, once })
  }
}

function isImportResolver(value: unknown): value is ImportResolver {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { resolve?: unknown }).resolve === "function"
  )
}

function decoratorBindings(
  imports: readonly ImportEdge[],
  candidates: readonly SymbolCandidate<OpaqueAstNode>[],
): Map<ImportEdge, Set<string>> {
  const wanted = new Map<ImportEdge, Set<string>>()
  const want = (edge: ImportEdge, name: string): void => {
    const names = wanted.get(edge)
    if (names === undefined) wanted.set(edge, new Set([name]))
    else names.add(name)
  }
  for (const candidate of candidates) {
    for (const decorator of candidate.decorators) {
      const { head, member } = decoratorReference(decorator)
      for (const edge of imports) {
        if (edge.dynamic) continue
        if (edge.symbols === "*") {
          if (decorator.qualifier !== undefined && edge.namespaceBinding === head) {
            want(edge, member)
          }
          continue
        }
        for (const raw of edge.symbols) {
          const binding = splitAliasedImportName(raw)
          if (binding.local === head) want(edge, binding.imported)
        }
      }
    }
  }
  return wanted
}

interface ClassModule {
  readonly file: string
  readonly edges: readonly ImportEdge[]
  readonly classes: DeclaredClasses
}

const NO_CLASSES: DeclaredClasses = new Map()

/** The classes the candidates of one module declare at its top level, by name. */
export function declaredClasses(
  candidates: readonly SymbolCandidate<OpaqueAstNode>[],
): DeclaredClasses {
  const members = new Map<string, Set<string>>()
  const classes = new Map<string, { superclass: string | undefined; members: Set<string> }>()
  for (const candidate of candidates) {
    const name = toNfc(candidate.name)
    const dot = name.indexOf(".")
    if (dot < 0) {
      if (candidate.kind !== "class") continue
      const own = members.get(name) ?? new Set<string>()
      members.set(name, own)
      for (const member of candidate.instanceMembers ?? []) {
        if (typeof member === "string") own.add(member)
      }
      const superclass = typeof candidate.superclass === "string" ? candidate.superclass : undefined
      classes.set(name, { superclass, members: own })
      continue
    }
    if (name.indexOf(".", dot + 1) >= 0) continue
    const owner = name.slice(0, dot)
    const own = members.get(owner) ?? new Set<string>()
    members.set(owner, own)
    own.add(name.slice(dot + 1))
  }
  return classes
}

// The import that binds `local`, or for `<namespace>.<name>` the namespace import, as a hop.
function importedAs(edges: readonly ImportEdge[], local: string): Hop | null {
  const dot = local.indexOf(".")
  const head = dot < 0 ? local : local.slice(0, dot)
  const rest = dot < 0 ? null : local.slice(dot + 1)
  let hop: Hop | null = null
  for (const edge of edges) {
    if (edge.dynamic) continue
    if (edge.symbols === "*") {
      if (rest !== null && !rest.includes(".") && edge.namespaceBinding === head) {
        hop = { source: edge.source, imported: rest }
      }
      continue
    }
    if (rest !== null) continue
    for (const raw of edge.symbols) {
      const binding = splitAliasedImportName(raw)
      if (binding.local === head) hop = { source: edge.source, imported: binding.imported }
    }
  }
  return hop
}

/** The names an edge binds in the importing module, as the edge's module exports them. */
function boundNames(edge: ImportEdge): readonly string[] {
  if (edge.dynamic) return []
  if (edge.symbols === "*") return edge.namespaceBinding === undefined ? [] : [NAMESPACE]
  return edge.symbols.map((raw) => splitAliasedImportName(raw).imported)
}

function reexportOf(edges: readonly ImportEdge[], name: string): Hop | null {
  for (const edge of edges) {
    if (edge.dynamic) continue
    const reexport = edge.reexports?.find((entry) => entry.exported === name)
    if (reexport !== undefined) return { source: edge.source, imported: reexport.imported }
  }
  return null
}

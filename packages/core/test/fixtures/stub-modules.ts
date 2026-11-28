import { importEdge, type ScratchWorkspace, spend } from "@aburi/test-support"
import {
  type CallCandidate,
  type Decorator,
  EXPORT_ASSIGNMENT_DERIVED_BY,
  EXPORT_CLAUSE_DERIVED_BY_PREFIX,
  EXPORT_DEFAULT_DERIVED_BY,
  EXPORT_KEYWORD_DERIVED_BY,
  type ImportEdge,
  type ImportResolver,
  type ImportResolverContext,
  type LanguagePlugin,
  type SymbolCandidate,
} from "@aburi/types"
import { fileCandidate, stubCandidate, stubLanguagePlugin } from "./plugins"

/**
 * How a `.stub` file exports a declaration: by its own name, as its default, as the value its
 * `export =` makes it, or under another name.
 */
export type StubExport = "keyword" | "default" | "assignment" | { readonly as: string }

export interface StubClass {
  readonly name: string
  readonly superclass?: string
  readonly members?: readonly string[]
  readonly exported?: StubExport
}

/**
 * What a `.stub` file holds, as JSON: its import edges, the decorators and calls of the Symbol
 * named after the file, and the classes and other names it declares.
 */
export interface StubModule {
  readonly imports?: readonly ImportEdge[]
  readonly decorators?: readonly Decorator[]
  readonly calls?: readonly CallCandidate[]
  readonly classes?: readonly StubClass[]
  /** Names it declares and exports under their own, besides its classes. */
  readonly exports?: readonly string[]
}

export type StubModules = Readonly<Record<string, StubModule>>

export type Aliases = Readonly<Record<string, readonly string[]>>

export const CONSUMER = "src/app.stub"

/** An import that binds names and republishes none of them. */
export function named(source: string, ...symbols: string[]): ImportEdge {
  return importEdge({ source, symbols })
}

export async function writeModules(
  workspace: Pick<ScratchWorkspace, "writeSource">,
  modules: StubModules,
): Promise<void> {
  for (const [path, module] of Object.entries(modules)) {
    await workspace.writeSource(path, JSON.stringify(module))
  }
}

export interface Recorder {
  parsed: string[]
  released: unknown[]
  resolversCreated: number
}

export const newRecorder = (): Recorder => ({ parsed: [], released: [], resolversCreated: 0 })

export interface ModuleLanguage {
  /** What the resolver maps a bare specifier to, where `resolve` is not given. */
  aliases?: Aliases
  recorder?: Recorder
  resolve?: (specifier: string) => Promise<readonly string[]>
  createResolver?: (ctx: ImportResolverContext) => ImportResolver
  /** A file whose parse throws. */
  unparsable?: string
  /** Files whose trees cannot be released. */
  unreleasable?: readonly string[]
  /** A file whose every parse takes this long. */
  slow?: { readonly path: string; readonly ms: number }
}

/** A `.stub` language that reads each file as a `StubModule`. */
export function moduleLanguage(options: ModuleLanguage = {}): LanguagePlugin {
  const recorder = options.recorder ?? newRecorder()
  const aliases = options.aliases ?? {}
  const resolve = options.resolve ?? (async (specifier: string) => aliases[specifier] ?? [])
  return stubLanguagePlugin({
    parseFile: async (file) => {
      recorder.parsed.push(file.path)
      if (file.path === options.unparsable) throw new Error("grammar crashed")
      if (file.path === options.slow?.path) spend(options.slow.ms)
      return {
        tree: { file: file.path },
        errors: [],
        imports: [...(read(file.content).imports ?? [])],
      }
    },
    releaseTree: (tree) => {
      recorder.released.push(tree)
      if (options.unreleasable?.includes((tree as { file: string }).file)) {
        throw new Error("tree pinned")
      }
    },
    extractSymbols: (_tree, ctx) => {
      const file = ctx.file.path
      const module = read(ctx.file.content)
      return [
        fileCandidate(file, { decorators: [...(module.decorators ?? [])] }),
        ...(module.classes ?? []).flatMap((declared) => classCandidates(file, declared)),
        ...(module.exports ?? []).map((name) =>
          stubCandidate(name, { file, kind: "const", derivedBy: exportTokens("keyword") }),
        ),
      ]
    },
    walkBody: (symbol, ctx) => ({
      rules: [],
      calls: symbol.kind === "function" ? [...(read(ctx.file.content).calls ?? [])] : [],
    }),
    createImportResolver: (ctx) => {
      recorder.resolversCreated++
      return options.createResolver === undefined ? { resolve } : options.createResolver(ctx)
    },
  })
}

const read = (content: string): StubModule => JSON.parse(content) as StubModule

function classCandidates(file: string, declared: StubClass): SymbolCandidate[] {
  const members = declared.members ?? []
  return [
    stubCandidate(declared.name, {
      file,
      kind: "class",
      ...(declared.exported === undefined ? {} : { derivedBy: exportTokens(declared.exported) }),
      ...(declared.superclass === undefined
        ? {}
        : { superclass: declared.superclass, instanceMembers: [...members] }),
    }),
    ...members.map((member) =>
      stubCandidate(`${declared.name}.${member}`, { file, kind: "method" }),
    ),
  ]
}

function exportTokens(exported: StubExport): string[] {
  if (exported === "keyword") return [EXPORT_KEYWORD_DERIVED_BY]
  if (exported === "default") return [EXPORT_DEFAULT_DERIVED_BY]
  if (exported === "assignment") return [EXPORT_ASSIGNMENT_DERIVED_BY]
  return [`${EXPORT_CLAUSE_DERIVED_BY_PREFIX}${exported.as}`]
}

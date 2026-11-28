import type {
  BodyExtraction,
  CallCandidate,
  ComponentId,
  Config,
  DeclinedCall,
  EffectPlugin,
  ExtractionContext,
  FrameworkClassifyContext,
  FrameworkPlugin,
  ImportEdge,
  Symbol as IRSymbol,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParsedTree,
  ParseError,
  SourceFile,
  SymbolCandidate,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import {
  type CallSiteBinding,
  type ClassHeritageEntry,
  type DeclaredReceiverType,
  isCallSiteRef,
  makeCallSiteKey,
  type ReceiverCallEntry,
  type ReturnSource,
  type ReturnSourceEntry,
  type ValueTypeEntry,
} from "../call-site"
import { assertIdLanguage, buildDroppedSymbol, buildKeptSymbol } from "./build-symbol"
import { type ClassifyCallsInput, classifyCalls } from "./classify-calls"
import { decideDropReason, mergeFrameworkClassification } from "./classify-symbol"
import type { DropCFilter } from "./drop-c"
import { describeJsonType, describeThrown } from "./faults"
import {
  type ImportOrigins,
  type ModuleDeclarations,
  moduleDeclarations,
  type SpecifierPaths,
} from "./import-origins"
import { normalizeCandidates, normalizeImportEdge } from "./normalize"
import { type ClassifyTimeoutEvent, type ParseTimeoutEvent, startParseDeadline } from "./timeout"
import type { VocabCheck } from "./vocab"

interface FileOutcomeCommon {
  path: string
  parseErrors: readonly ParseError[]
}

export interface ExtractedFile extends FileOutcomeCommon {
  kind: "extracted"
  symbols: IRSymbol[]
  imports: readonly ImportEdge[]
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  dynamicCallSites: readonly string[]
  declinedCalls: readonly DeclinedCall[]
  thisBindings: readonly CallSiteBinding[]
  declaredReceiverTypes: readonly DeclaredReceiverType[]
  /** By `makeSymbolCallKey`: each call whose receiver's leading name one of the file's imports binds. */
  importedReceivers: readonly string[]
  /** Each class the file declares that extends a name, dropped or kept. */
  classHeritages: readonly ClassHeritageEntry[]
  /** Each variable the file declares with a named type or constructs from a class, dropped or kept. */
  valueTypes: readonly ValueTypeEntry[]
  /** What a call of each function the file declares gives back, dropped or kept, where it says. */
  returnSources: readonly ReturnSourceEntry[]
  /** By `makeSymbolCallKey`: the call each call's receiver is the result of. */
  receiverCalls: readonly ReceiverCallEntry[]
  /** By `makeSymbolCallKey`: each call whose leading name no scope around it declares. */
  unboundHeads: readonly string[]
  /** By `makeSymbolCallKey`: each call whose leading name a scope nearer it than the module declares. */
  localHeads: readonly string[]
  /**
   * What the language maps the file's bare specifiers to, which call resolution and the Component
   * import edges probe.
   */
  specifierPaths: readonly SpecifierPaths[]
  /** What withdraws the file although nothing threw; its `symbols` are then empty. */
  fault: FileFault | null
}

export interface FileFault {
  code: string
  message: string
}

export interface ParseFailedFile extends FileOutcomeCommon {
  kind: "parse-failed"
  imports: readonly ImportEdge[]
}

export interface ParseTimeoutFile extends FileOutcomeCommon {
  kind: "parse-timeout"
  timeout: ParseTimeoutEvent
}

export type FilePipelineResult = ExtractedFile | ParseFailedFile | ParseTimeoutFile

export interface FilePipelineInput {
  file: SourceFile
  language: LanguagePlugin
  frameworks: readonly FrameworkPlugin[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  config: Config
  dropCFilter: DropCFilter
  component: ComponentId | null
  log: Logger
  treeReleaseFailures: TreeReleaseFailure[]
  vocab: VocabCheck
  origins?: ImportOrigins
}

export interface TreeReleaseFailure {
  plugin: string
  file: string
  detail: string
}

export async function runFilePipeline(input: FilePipelineInput): Promise<FilePipelineResult> {
  const {
    file,
    language,
    frameworks,
    effects,
    registry,
    config,
    dropCFilter,
    component,
    log,
    vocab,
  } = input

  const deadline = startParseDeadline(config.parseTimeoutMs)
  const abandonedFile = (): ParseTimeoutFile => ({
    kind: "parse-timeout",
    path: file.path,
    parseErrors,
    timeout: {
      file: file.path,
      budgetMs: deadline.budgetMs,
      elapsedMs: deadline.elapsedMs(),
    },
  })

  const parseResult = await language.parseFile(file)
  const parseErrors = parseResult.errors
  const timeoutEvents: ClassifyTimeoutEvent[] = []

  try {
    const writtenImports = parseResult.imports.map(normalizeImportEdge)

    if (parseResult.tree === null || parseErrors.some((error) => error.recoverable === false)) {
      return { kind: "parse-failed", path: file.path, parseErrors, imports: writtenImports }
    }

    if (deadline.expired()) return abandonedFile()

    const extractCtx: ExtractionContext = { file, registry, config }
    const candidates = normalizeCandidates(
      language.extractSymbols(parseResult.tree, extractCtx),
      language.manifest.name,
    )
    if (!Array.isArray(candidates)) {
      return {
        kind: "extracted",
        path: file.path,
        parseErrors,
        symbols: [],
        imports: writtenImports,
        timeoutEvents,
        dynamicCallSites: [],
        declinedCalls: [],
        thisBindings: [],
        declaredReceiverTypes: [],
        importedReceivers: [],
        classHeritages: [],
        valueTypes: [],
        returnSources: [],
        receiverCalls: [],
        unboundHeads: [],
        localHeads: [],
        specifierPaths: [],
        fault: {
          code: candidates.code,
          message: `${candidates.message}. ctx.file.path holds this file's path already spelled for the Document, so this is a path the language plugin built`,
        },
      }
    }
    if (deadline.expired()) return abandonedFile()

    const origins = input.origins
    // Which importer pays for a barrel's parse would depend on discovery order.
    const imports =
      origins === undefined || frameworks.length === 0
        ? writtenImports
        : await deadline.excluding(() => origins.attach(file, writtenImports, candidates))

    const classHeritages = candidates.flatMap(classHeritageOf)
    const valueTypes = candidates.flatMap(valueTypeOf)
    const returnSources = candidates.flatMap((candidate) => returnSourceOf(candidate, file.path))
    const symbols: IRSymbol[] = []
    const dynamicCallSites: string[] = []
    const declinedCalls: DeclinedCall[] = []
    const thisBindings: CallSiteBinding[] = []
    const declaredReceiverTypes: DeclaredReceiverType[] = []
    const importedReceivers: string[] = []
    const receiverCalls: ReceiverCallEntry[] = []
    const unboundHeads: string[] = []
    const localHeads: string[] = []

    const frameworkCtx: FrameworkClassifyContext = { ...extractCtx, imports }
    // What a client imported from another file is reaches the effect plugins only, and only
    // through the edges they are handed: the Document and call resolution read the file's own.
    // Following an edge parses the module it leads to, so a file whose bodies make no call
    // follows none.
    let effectImports: readonly ImportEdge[] | null =
      origins === undefined || effects.length === 0 ? imports : null
    // Another file's calls may be made on a class this one declares, or on a name it exports.
    const declarations: ModuleDeclarations | null =
      origins === undefined || effects.length === 0 ? null : moduleDeclarations(candidates)
    if (declarations !== null) origins?.rememberDeclarations(file.path, declarations)

    for (const written of candidates) {
      if (deadline.expired()) return abandonedFile()

      const { candidate, confidence, extKindBy, middleware, calls } = mergeFrameworkClassification(
        written,
        frameworks,
        frameworkCtx,
        language.manifest.name,
      )
      if (candidate.extKind !== null && extKindBy !== null) {
        vocab.extKind({
          value: candidate.extKind,
          plugin: extKindBy,
          file: file.path,
          line: null,
          symbol: candidate.id,
        })
      }
      assertIdLanguage(candidate.id, language.manifest)
      const dropReason = decideDropReason(candidate, language, frameworks, frameworkCtx)

      if (dropReason !== null) {
        symbols.push(
          buildDroppedSymbol(
            candidate,
            dropReason,
            language.manifest.languageId,
            component,
            confidence,
          ),
        )
        continue
      }

      const walkCtx: WalkContext<OpaqueAstNode> = { ...extractCtx, symbol: candidate }
      const body: BodyExtraction = language.walkBody(candidate, walkCtx)
      let memberCalls: ReadonlySet<CallCandidate> = NO_CALLS
      if (origins !== undefined && declarations !== null && body.calls.length > 0) {
        // First, so a module a receiver's class is read from is parsed once for both.
        memberCalls = await deadline.excluding(() =>
          origins.callsOnWorkspaceMembers(file.path, imports, declarations.classes, body.calls),
        )
        effectImports ??= await deadline.excluding(() => origins.attachUpstream(file.path, imports))
      }

      const classifyCallsInput: ClassifyCallsInput = {
        calls: body.calls,
        effects,
        registry,
        config,
        component,
        candidate,
        file,
        language: language.manifest.languageId,
        imports: effectImports ?? imports,
        memberCalls,
        dropCFilter,
        timeoutEvents,
        vocab,
      }
      if (config.classifyTimeoutMs !== undefined)
        classifyCallsInput.classifyTimeoutMs = config.classifyTimeoutMs
      const {
        effects: classifiedEffects,
        calls: keptCalls,
        dynamicCallSites: fileDynamicCallSites,
        declinedCalls: fileDeclinedCalls,
        thisBindings: fileThisBindings,
        declaredReceiverTypes: fileDeclaredReceiverTypes,
        importedReceivers: fileImportedReceivers,
        receiverCalls: fileReceiverCalls,
        unboundHeads: fileUnboundHeads,
        localHeads: fileLocalHeads,
      } = classifyCalls(classifyCallsInput)
      dynamicCallSites.push(...fileDynamicCallSites)
      declinedCalls.push(...fileDeclinedCalls)
      thisBindings.push(...fileThisBindings)
      declaredReceiverTypes.push(...fileDeclaredReceiverTypes)
      importedReceivers.push(...fileImportedReceivers)
      receiverCalls.push(...fileReceiverCalls)
      unboundHeads.push(...fileUnboundHeads)
      localHeads.push(...fileLocalHeads)

      const normalized = language.normalizeAst(candidate)
      symbols.push(
        buildKeptSymbol({
          candidate,
          language: language.manifest.languageId,
          component,
          rules: body.rules,
          effects: classifiedEffects,
          // Last among a shared line's calls, as the stable sort by line keeps them: a Call has no
          // column to place them by.
          calls: [...keptCalls, ...calls],
          middleware,
          normalizedAstString: normalized,
          confidence,
        }),
      )
    }

    log.debug(`scan/pipeline: ${file.path} produced ${symbols.length} symbols`)
    // Each lookup asks the language's resolver, so only a file something reads the answer for is
    // mapped. Call resolution binds names through the file's imports for each call it makes, for
    // what it re-exports as a barrel, and for each type or name a declaration of it says a value
    // is: an `extends`, a variable's type, what a function gives back. The Component graph draws
    // an edge for each import of a file in a Component.
    const readsMapping =
      component !== null ||
      symbols.some((symbol) => symbol.calls.length > 0) ||
      writtenImports.some(reexportsAny) ||
      classHeritages.length + valueTypes.length + returnSources.length > 0
    const specifierPaths =
      origins === undefined || !readsMapping
        ? []
        : await deadline.excluding(() => origins.mapSpecifiers(file.path, writtenImports))

    return {
      kind: "extracted",
      path: file.path,
      parseErrors,
      symbols,
      imports,
      timeoutEvents,
      dynamicCallSites,
      declinedCalls,
      thisBindings,
      declaredReceiverTypes,
      importedReceivers,
      classHeritages,
      valueTypes,
      returnSources,
      receiverCalls,
      unboundHeads,
      localHeads,
      specifierPaths,
      fault: null,
    }
  } finally {
    if (parseResult.tree !== null) {
      releaseParsedTree(language, parseResult.tree, file, input.treeReleaseFailures)
    }
  }
}

// A plugin outside the tree may write anything, and a heritage is only a hint.
function classHeritageOf(candidate: SymbolCandidate<OpaqueAstNode>): ClassHeritageEntry[] {
  const { id, kind, superclass, instanceMembers } = candidate
  if (kind !== "class" || typeof superclass !== "string") return []
  const members = Array.isArray(instanceMembers) ? instanceMembers : []
  return [[id, { superclass, instanceMembers: members.filter((name) => typeof name === "string") }]]
}

function valueTypeOf(candidate: SymbolCandidate<OpaqueAstNode>): ValueTypeEntry[] {
  const { id, kind, valueType } = candidate
  const variable = kind === "const" || kind === "variable"
  return variable && typeof valueType === "string" ? [[id, valueType]] : []
}

// A plugin outside the tree may write anything, and a value with two sources names neither.
function returnSourceOf(
  candidate: SymbolCandidate<OpaqueAstNode>,
  file: string,
): ReturnSourceEntry[] {
  const { id, kind, returns } = candidate
  if (typeof returns !== "object" || returns === null) return []
  const source = returnSourceFrom(returns, kind, file)
  return source === null ? [] : [[id, source]]
}

const RETURN_SOURCE_KEYS = ["type", "call", "reference", "self"] as const

function returnSourceFrom(returns: object, kind: string, file: string): ReturnSource | null {
  const written = RETURN_SOURCE_KEYS.filter(
    (key) => key in returns && Reflect.get(returns, key) !== undefined,
  )
  const [key, ...others] = written
  if (key === undefined || others.length > 0) return null
  const value: unknown = Reflect.get(returns, key)
  if (kind === "const" || kind === "variable") {
    return key === "reference" && isName(value) ? { reference: value } : null
  }
  if (kind !== "function" && kind !== "method") return null
  switch (key) {
    case "type":
      return isName(value) ? { type: value } : null
    case "self":
      return value === true ? { self: true } : null
    case "call":
      return isCallSiteRef(value)
        ? { callSite: makeCallSiteKey(file, value.line, value.target) }
        : null
    default:
      return null
  }
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

const NO_CALLS: ReadonlySet<CallCandidate> = new Set()

function reexportsAny(edge: ImportEdge): boolean {
  return edge.reexportsAll === true || (edge.reexports?.length ?? 0) > 0
}

export function releaseParsedTree(
  language: LanguagePlugin,
  tree: ParsedTree,
  file: SourceFile,
  failures: TreeReleaseFailure[],
): void {
  const release: unknown = language.releaseTree
  if (release === undefined || release === null) return

  const record = (detail: string): void => {
    failures.push({ plugin: language.manifest.name, file: file.path, detail })
  }

  if (typeof release !== "function") {
    record(`releaseTree is ${describeJsonType(release)}, not a function`)
    return
  }
  try {
    ;(release as (this: LanguagePlugin, tree: ParsedTree) => void).call(language, tree)
  } catch (error) {
    record(describeThrown(error))
  }
}

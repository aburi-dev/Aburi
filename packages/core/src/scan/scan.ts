import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import {
  type Component,
  type Config,
  type EffectPlugin,
  type FrameworkPlugin,
  GRAMMAR_REVISION_PATTERN,
  type IR,
  IR_SCHEMA_URL,
  type LanguagePlugin,
  type Logger,
  type UnresolvedCallDiagnostic,
  type VocabRegistry,
  type WorkspaceManager,
} from "@aburi/types"
import { resolveCallGraph } from "../callgraph"
import { type SerializeOptions, serializeCanonical } from "../canonical"
import { groupBy } from "../collections"
import type { WorkspacePackage } from "../component-manifest"
import { CoreError } from "../errors"
import { logicFingerprint } from "../fingerprint"
import { assertIRIntegrity } from "../integrity"
import { silentLogger } from "../logger"
import { enrichWithLsp, type ServerFactory, withHintUsage } from "../lsp"
import { compareBy } from "../order"
import { propagateEffects } from "../propagate"
import { componentImportEdges } from "./component-edges"
import { discoverFiles, type SkippedFile, type UnrepresentableFile } from "./discover"
import {
  buildPluginRefs,
  buildStats,
  compareDependencies,
  projectSymbolEdges,
  recordedGrammarRevision,
  sortComponents,
  uniqueSorted,
} from "./document"
import {
  type ExtractionFailure,
  extractFiles,
  type ParseErrorRecord,
  type ParsePoolFactory,
} from "./extract-files"
import { markGeneratedFiles, withGeneratedCallCensus } from "./generated-files"
import type { TreeReleaseFailure } from "./pipeline"
import { buildLanguageRouter, type LanguageRouter } from "./route"
import { markTestFiles } from "./test-files"
import type { ClassifyTimeoutEvent, ParseTimeoutEvent } from "./timeout"
import type { UndeclaredVocabOccurrence } from "./vocab"

export type { ExtractionFailure, ParseErrorRecord } from "./extract-files"

/**
 * Where a scan is, for a caller that shows it. The phases are entered in this order, each once:
 * `discovering`; `extracting`, sent before each file and once more when the last one is done;
 * then `resolving`, everything after extraction.
 */
export type ScanProgress =
  | { readonly phase: "discovering" }
  | {
      readonly phase: "extracting"
      /** Files extracted so far, counting up to `total`. */
      readonly done: number
      /** Files the scan will extract. */
      readonly total: number
    }
  | { readonly phase: "resolving" }

export interface ScanInput {
  workspaceRoot: string
  /**
   * Absolute: the checkout of the same repository whose installed dependencies stand in for the
   * workspace's, when the workspace is a checkout made without them.
   */
  installedRoot?: string
  config: Config
  languages: readonly LanguagePlugin[]
  frameworks: readonly FrameworkPlugin[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  logger?: Logger
  workspaceManagers?: readonly WorkspaceManager[]
  components?: readonly Component[]
  /**
   * Every package of the workspace: what a bare import specifier is matched against to find the
   * Component it imports, to tell a workspace package from one outside the workspace, and, by its
   * entry points, to find the file a call into the package by its name reaches. Left out,
   * every package imported by its name, with no `paths` key mapping it, reads as one outside the
   * workspace, and `ImportEdge.origins` names it as the package a decorator comes from.
   */
  workspacePackages?: readonly WorkspacePackage[]
  generator?: { name: string; version: string }
  lspServerFactory?: ServerFactory
  /** Without one, or when it answers `null`, the scan extracts one file at a time on its own thread. */
  parsePool?: ParsePoolFactory
  onProgress?: (progress: ScanProgress) => void
  /**
   * Checked before each file the scan extracts or enriches through LSP, and before each phase up
   * to call resolution; once aborted, the scan rejects with its reason.
   */
  signal?: AbortSignal
}

export interface ScanResult {
  ir: IR
  parseErrors: readonly ParseErrorRecord[]
  skipped: readonly SkippedFile[]
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  parseTimeouts: readonly ParseTimeoutEvent[]
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
  extractionFailures: readonly ExtractionFailure[]
  treeReleaseFailures: readonly TreeReleaseFailure[]
  undeclaredVocab: readonly UndeclaredVocabOccurrence[]
  unrepresentableFiles: readonly UnrepresentableFile[]
  lspWarnings: readonly string[]
}

export async function scan(input: ScanInput): Promise<ScanResult> {
  assertWorkspaceRootAbsolute(input.workspaceRoot)
  assertLanguageIdsDeclared(input.languages)
  assertGrammarRevisionsWellFormed(input.languages)
  const logger = input.logger ?? silentLogger
  const progress = input.onProgress ?? (() => {})
  const { signal } = input
  signal?.throwIfAborted()

  const router = buildLanguageRouter(input.languages)
  const langDropPatterns = languageFileDropPatterns(input.languages)

  const discoverOptions: Parameters<typeof discoverFiles>[0] = {
    workspaceRoot: input.workspaceRoot,
    ignore: input.config.ignore ?? [],
    langDropPatterns,
    respectGitignore: input.config.respectGitignore ?? true,
    languageExtensions: router.knownExtensions,
  }
  if (input.config.maxFileSizeBytes !== undefined) {
    discoverOptions.maxFileSizeBytes = input.config.maxFileSizeBytes
  }
  progress({ phase: "discovering" })
  const discovered = await discoverFiles(discoverOptions)

  signal?.throwIfAborted()
  const extracted = await extractFiles({
    workspaceRoot: input.workspaceRoot,
    ...(input.installedRoot === undefined ? {} : { installedRoot: input.installedRoot }),
    files: discovered.files,
    config: input.config,
    components: input.components ?? [],
    workspacePackages: input.workspacePackages ?? [],
    languages: input.languages,
    frameworks: input.frameworks,
    effects: input.effects,
    registry: input.registry,
    logger,
    ...(input.parsePool === undefined ? {} : { parsePool: input.parsePool }),
    progress: (done, total) => progress({ phase: "extracting", done, total }),
    ...(signal === undefined ? {} : { signal }),
  })
  progress({ phase: "resolving" })
  const { symbols } = extracted

  symbols.sort(compareBy((symbol) => symbol.id))

  const enrichmentInput: Parameters<typeof enrichWithLsp>[0] = {
    symbols,
    workspaceRoot: input.workspaceRoot,
    fileContents: extracted.fileContents,
    lspConfig: input.config.lsp,
    languageIds: input.languages.map((plugin) => plugin.manifest.languageId),
    thisBindings: extracted.thisBindings,
    logger,
  }
  if (input.lspServerFactory !== undefined) enrichmentInput.serverFactory = input.lspServerFactory
  if (signal !== undefined) enrichmentInput.signal = signal
  const enrichment = await enrichWithLsp(enrichmentInput)
  const enrichedSymbols = enrichment.symbols
  enrichedSymbols.sort(compareBy((symbol) => symbol.id))

  signal?.throwIfAborted()
  const callGraph = resolveCallGraph({
    symbols: enrichedSymbols,
    importsByFile: extracted.importsByFile,
    receiverHints: enrichment.receiverHints,
    implementerHints: enrichment.implementerHints,
    dynamicCallSites: extracted.dynamicCallSites,
    declaredReceiverTypes: extracted.declaredReceiverTypes,
    classHeritages: extracted.classHeritages,
    valueTypes: extracted.valueTypes,
    specifierPaths: extracted.specifierPaths,
    moduleFiles: moduleFilesOf(extracted.importsByFile.keys(), router),
  })
  const symbolEdges = projectSymbolEdges(callGraph.edges)
  const componentEdges = componentImportEdges({
    importsByFile: extracted.importsByFile,
    withdrawn: new Set(extracted.skipped.map((file) => file.path)),
    components: input.components ?? [],
    packages: input.workspacePackages ?? [],
  })
  for (const { name, components } of componentEdges.contested) {
    logger.warn(
      `${name} names a package in each of the Components ${components.join(", ")}, so an import of it draws no Component edge.`,
    )
  }

  const propagation = propagateEffects({
    symbols: callGraph.symbols,
    edges: callGraph.edges,
  })
  const propagatedSymbols = markGeneratedFiles(
    markTestFiles(
      propagation.symbols.map((s) =>
        s.dropped
          ? s
          : {
              ...s,
              fingerprint: { ...s.fingerprint, logic: logicFingerprint(s) },
            },
      ),
      input.config,
    ),
    extracted.fileContents,
  )

  const skipped = [...discovered.skipped, ...extracted.skipped].sort(compareBy((file) => file.path))
  const stats = buildStats({
    totalFiles: discovered.files.length + discovered.skipped.length,
    parsedFiles: discovered.files.length - extracted.skipped.length,
    skipped,
    symbols: propagatedSymbols,
    timeoutEvents: extracted.timeoutEvents,
    declinedCalls: extracted.declinedCalls,
    propagation: propagation.stats,
    lspEnrichment:
      enrichment.stats === undefined
        ? undefined
        : withHintUsage(enrichment.stats, callGraph.lspHintUsage),
    callResolution: withGeneratedCallCensus(
      callGraph.stats,
      propagatedSymbols,
      callGraph.diagnostics,
    ),
  })

  const workspace: IR["workspace"] = {
    root: ".",
    managers: [...(input.workspaceManagers ?? [])],
    languages: uniqueSorted(input.languages.map((l) => l.manifest.languageId)),
  }

  const ir: IR = {
    $schema: IR_SCHEMA_URL,
    generator: {
      name: input.generator?.name ?? "@aburi/core",
      version: input.generator?.version ?? "0.0.0",
      plugins: buildPluginRefs(input),
    },
    workspace,
    components: sortComponents(input.components ?? []),
    symbols: propagatedSymbols,
    dependencies: [...symbolEdges, ...componentEdges.dependencies].sort(compareDependencies),
    stats,
  }

  assertIRIntegrity(ir)

  return {
    ir,
    parseErrors: extracted.parseErrors,
    skipped,
    timeoutEvents: extracted.timeoutEvents,
    parseTimeouts: extracted.parseTimeouts,
    unresolvedCalls: callGraph.diagnostics,
    extractionFailures: extracted.extractionFailures,
    treeReleaseFailures: extracted.treeReleaseFailures,
    unrepresentableFiles: discovered.unrepresentableFiles,
    undeclaredVocab: extracted.undeclaredVocab,
    lspWarnings: enrichment.warnings,
  }
}

export type WriteCanonicalIROptions = SerializeOptions

export async function writeCanonicalIR(
  ir: IR,
  outputPath: string,
  options: WriteCanonicalIROptions = {},
): Promise<string> {
  const serialized = serializeCanonical(ir, options)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, serialized, "utf8")
  return serialized
}

function assertWorkspaceRootAbsolute(root: string): void {
  if (!isAbsolute(root)) {
    throw new CoreError(
      `ScanInput.workspaceRoot must be an absolute path, got "${root}". A relative root would be resolved against process.cwd() and produce non-portable Symbol ids.`,
      { code: "scan-workspace-not-absolute", value: root },
    )
  }
}

/** The registry refuses such a manifest; a caller that skips it reaches `scan` with one. */
function assertLanguageIdsDeclared(languages: readonly LanguagePlugin[]): void {
  for (const { manifest } of languages) {
    const declared: unknown = manifest.languageId
    if (typeof declared === "string") continue
    const found =
      declared === undefined
        ? "declares no languageId"
        : `declares languageId ${JSON.stringify(declared)}, which is not a string`
    throw new CoreError(
      `Language plugin "${manifest.name}" ${found} in its manifest: the manifest names the <language> token its Symbol ids open with, e.g. "ts". If the plugin object sets languageId, move it into the manifest.`,
      { code: "scan-plugin-misconfigured", value: manifest.name },
    )
  }
}

/**
 * The registry checks only a declared revision, and holds a version to no suffix form, so a revision
 * recorded off the schema's form would leave the Document off its schema.
 */
function assertGrammarRevisionsWellFormed(languages: readonly LanguagePlugin[]): void {
  const form = `a grammar revision is "<grammar-package>@<MAJOR.MINOR.PATCH>", e.g. "tree-sitter-typescript@0.23.2"`
  for (const { manifest } of languages) {
    const declared: unknown = manifest.grammarRevision
    if (declared === undefined) {
      const recorded = recordedGrammarRevision(manifest)
      if (GRAMMAR_REVISION_PATTERN.test(recorded)) continue
      throw new CoreError(
        `Language plugin "${manifest.name}" declares no grammarRevision, so its revision would be "${recorded}", but ${form}. Declare the plugin's grammarRevision in its manifest.`,
        { code: "scan-plugin-misconfigured", value: manifest.name },
      )
    }
    if (typeof declared === "string" && GRAMMAR_REVISION_PATTERN.test(declared)) continue
    throw new CoreError(
      `Language plugin "${manifest.name}" declares grammarRevision ${JSON.stringify(declared)} in its manifest, but ${form}.`,
      { code: "scan-plugin-misconfigured", value: manifest.name },
    )
  }
}

export function languageFileDropPatterns(languages: readonly LanguagePlugin[]): string[] {
  const patterns: string[] = []
  for (const language of languages) {
    if (language.fileDropPatterns) patterns.push(...language.fileDropPatterns)
  }
  return patterns
}

function moduleFilesOf(paths: Iterable<string>, router: LanguageRouter): Map<string, Set<string>> {
  const routed = [...paths].flatMap((path) => {
    const language = router.route(path)?.manifest.languageId
    return language === undefined ? [] : [{ path, language }]
  })
  const byLanguage = groupBy(routed, (file) => file.language)
  return new Map(
    [...byLanguage].map(([language, files]) => [language, new Set(files.map((f) => f.path))]),
  )
}

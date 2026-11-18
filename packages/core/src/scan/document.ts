import type {
  CallResolutionStats,
  Component,
  DeclinedCall,
  Dependency,
  EffectClassifyTimeout,
  EffectPlugin,
  FrameworkPlugin,
  IR,
  LanguagePlugin,
  LspEnrichmentStats,
  PluginManifest,
  PluginRef,
  Stats,
} from "@aburi/types"
import { dependencyKey } from "../call-site"
import type { CallEdge } from "../callgraph"
import { compareBy, compareCodeUnit, compareDeclinedCalls } from "../order"
import type { PropagationStats } from "../propagate"
import type { SkippedFile } from "./discover"
import type { ClassifyTimeoutEvent } from "./timeout"

export interface BuildStatsInput {
  totalFiles: number
  parsedFiles: number
  skipped: readonly SkippedFile[]
  symbols: readonly IR["symbols"][number][]
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  declinedCalls: readonly DeclinedCall[]
  propagation: PropagationStats
  lspEnrichment?: LspEnrichmentStats | undefined
  callResolution: CallResolutionStats
}

export function buildStats(input: BuildStatsInput): Stats {
  const kept = input.symbols.filter((s) => !s.dropped).length
  const dropped = input.symbols.length - kept
  const stats: Stats = {
    totalFiles: input.totalFiles,
    parsedFiles: input.parsedFiles,
    keptSymbols: kept,
    droppedSymbols: dropped,
    effectPropagation: input.propagation,
    callResolution: input.callResolution,
  }
  if (input.timeoutEvents.length > 0) {
    stats.effectClassifyTimeouts = input.timeoutEvents.map(
      (event): EffectClassifyTimeout => ({
        plugin: event.plugin,
        symbolId: event.symbolId,
        timeoutMs: event.budgetMs,
      }),
    )
  }
  if (input.declinedCalls.length > 0)
    stats.declinedCalls = [...input.declinedCalls].sort(compareDeclinedCalls)
  if (input.lspEnrichment !== undefined) {
    stats.lspEnrichment = input.lspEnrichment
  }
  if (input.skipped.length > 0) {
    stats.skippedFiles = input.skipped.map((file) => ({ path: file.path, reason: file.reason }))
  }
  return stats
}

export function sortComponents(components: readonly Component[]): Component[] {
  return components
    .map((c) => ({ ...c, description: c.description ?? null }))
    .sort(compareBy((component) => component.id))
}

export function projectSymbolEdges(edges: readonly CallEdge[]): Dependency[] {
  const seen = new Set<string>()
  const out: Dependency[] = []
  for (const edge of edges) {
    const key = dependencyKey(edge.from, edge.to, edge.via)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      from: edge.from,
      to: edge.to,
      via: edge.via,
      direction: "outbound",
      effect: null,
    })
  }
  return out.sort(compareDependencies)
}

export function compareDependencies(a: Dependency, b: Dependency): number {
  return (
    compareCodeUnit(a.from, b.from) || compareCodeUnit(a.to, b.to) || compareCodeUnit(a.via, b.via)
  )
}

export function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCodeUnit)
}

export interface PluginSet {
  languages: readonly LanguagePlugin[]
  frameworks: readonly FrameworkPlugin[]
  effects: readonly EffectPlugin[]
}

export function buildPluginRefs(input: PluginSet): PluginRef[] {
  const refs: PluginRef[] = [
    ...input.languages.map(({ manifest }) =>
      pluginRef(manifest, "lang", recordedGrammarRevision(manifest)),
    ),
    ...input.frameworks.map(({ manifest }) => pluginRef(manifest, "framework", null)),
    ...input.effects.map(({ manifest }) => pluginRef(manifest, "effects", null)),
  ]
  refs.sort(compareBy((ref) => ref.name))
  return refs
}

function pluginRef(
  { name, version }: PluginManifest,
  type: PluginRef["type"],
  grammarRevision: string | null,
): PluginRef {
  return { name, type, version, grammarRevision }
}

// Build metadata names a build of one release, and the revision form takes one suffix, not two.
export function recordedGrammarRevision(manifest: PluginManifest): string {
  return manifest.grammarRevision ?? `${manifest.name}@${manifest.version.replace(/\+.*$/, "")}`
}

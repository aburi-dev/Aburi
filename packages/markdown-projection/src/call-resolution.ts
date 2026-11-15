import type {
  CallResolutionStats,
  GeneratedCallResolutionStats,
  UnresolvedCallBuckets,
} from "@aburi/types"

const BUCKET_LABELS: Readonly<Record<keyof UnresolvedCallBuckets, string>> = {
  localScope: "local-scope",
  external: "external",
  dynamic: "dynamic",
  ambiguous: "ambiguous",
  noMatch: "no-match",
}

const BUCKETS = Object.keys(BUCKET_LABELS) as (keyof UnresolvedCallBuckets)[]

export function formatCallResolutionLine(stats: CallResolutionStats): string {
  const { generated } = stats
  if (generated === undefined) return censusLine(stats)
  return `${censusLine(authored(stats, generated))}; generated files: calls ${generated.totalCalls} · resolved ${generated.resolvedCalls}`
}

function authored(
  stats: CallResolutionStats,
  generated: GeneratedCallResolutionStats,
): GeneratedCallResolutionStats {
  const unresolved = { ...stats.unresolved }
  for (const key of BUCKETS) unresolved[key] -= generated.unresolved[key]
  return {
    totalCalls: stats.totalCalls - generated.totalCalls,
    resolvedCalls: stats.resolvedCalls - generated.resolvedCalls,
    unresolved,
  }
}

function censusLine(stats: GeneratedCallResolutionStats): string {
  const head = `calls ${stats.totalCalls} · resolved ${stats.resolvedCalls} · unresolved ${
    stats.totalCalls - stats.resolvedCalls
  }`
  const parts: string[] = []
  for (const key of BUCKETS) {
    const count = stats.unresolved[key]
    if (count > 0) parts.push(`${BUCKET_LABELS[key]} ${count}`)
  }
  if (parts.length === 0) return head
  return `${head} (${parts.join(" · ")})`
}

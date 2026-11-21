import {
  authoredCallCensus,
  type CallCensus,
  type CallResolutionStats,
  type UnresolvedCallBuckets,
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
  return `${censusLine(authoredCallCensus(stats))}; generated files: calls ${generated.totalCalls} · resolved ${generated.resolvedCalls}`
}

function censusLine(stats: CallCensus): string {
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

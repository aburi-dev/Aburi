import type { CallCensus, CallResolutionStats, UnresolvedCallBuckets } from "./generated/ir"

/**
 * The whole census still counts the generated files' calls, for readers written before their
 * block, so the code a workspace's authors wrote is what is left once that block comes off.
 */
export function authoredCallCensus(stats: CallResolutionStats): CallCensus {
  const { generated } = stats
  const unresolved = { ...stats.unresolved }
  if (generated === undefined) {
    return { totalCalls: stats.totalCalls, resolvedCalls: stats.resolvedCalls, unresolved }
  }
  for (const bucket of Object.keys(unresolved) as (keyof UnresolvedCallBuckets)[]) {
    unresolved[bucket] -= generated.unresolved[bucket]
  }
  return {
    totalCalls: stats.totalCalls - generated.totalCalls,
    resolvedCalls: stats.resolvedCalls - generated.resolvedCalls,
    unresolved,
  }
}

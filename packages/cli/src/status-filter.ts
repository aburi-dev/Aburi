import {
  type DiffResult,
  isSymbolChangeStatus,
  SYMBOL_CHANGE_STATUSES,
  type SymbolChangeStatus,
} from "@aburi/types"
import { DIFF_MD_FILENAME } from "./artifact-paths"
import { CliError } from "./errors"
import { countedChanges, formatClause, parseClause, type TrippedClause } from "./fail-on"

/** A comma-separated `--filter` value, or the statuses a caller of `runDiff` holds as a list. */
export function parseFilter(value: string | readonly string[]): SymbolChangeStatus[] {
  const written = typeof value === "string"
  const segments = written ? value.split(",").map((segment) => segment.trim()) : value
  const refuse = (reason: string): never => {
    throw new CliError(
      `--filter value "${written ? value : value.join(",")}" is invalid: ${reason} The statuses are ${SYMBOL_CHANGE_STATUSES.join(", ")}.`,
      "input-error",
    )
  }
  if (segments.every((segment) => segment.length === 0)) {
    refuse(
      "it names no status, and a report filtered to nothing reads as a diff that found nothing.",
    )
  }
  const statuses = new Set<SymbolChangeStatus>()
  for (const [index, segment] of segments.entries()) {
    if (written && segment.length === 0) {
      refuse(`segment ${index + 1} of ${segments.length} is empty; remove the extra comma.`)
    }
    if (isSymbolChangeStatus(segment)) {
      statuses.add(segment)
      continue
    }
    const status = clauseStatus(segment)
    refuse(
      status === null
        ? `"${segment}" is no status.`
        : `"${segment}" is a --fail-on clause, not a status; the report lists those changes under "${status}".`,
    )
  }
  return [...statuses]
}

/** The status whose changes a `--fail-on` clause such as `removed:duplicate` counts among. */
function clauseStatus(segment: string): SymbolChangeStatus | null {
  if (!segment.includes(":")) return null
  const head = parseClause(segment)?.token.split(":")[0]
  return isSymbolChangeStatus(head) ? head : null
}

/**
 * The gate's lines name the Symbols the tripped clause counted, so a reader looking for them in
 * the report is told which ones `statuses` left out of it.
 */
export function unlistedTripped(
  tripped: TrippedClause,
  diff: DiffResult,
  statuses: readonly SymbolChangeStatus[],
): string | null {
  const kept = new Set(statuses)
  const unlisted = countedChanges(tripped.clause.token, diff, tripped.scope).filter(
    (change) => !kept.has(change.status),
  )
  if (unlisted.length === 0) return null
  const byStatus = SYMBOL_CHANGE_STATUSES.flatMap((status) => {
    const count = unlisted.filter((change) => change.status === status).length
    return count === 0 ? [] : [`${count} ${status}`]
  })
  const which =
    unlisted.length === tripped.observed
      ? "every change"
      : `${unlisted.length} of the ${tripped.observed} changes`
  return `⚠ --filter leaves out of ${DIFF_MD_FILENAME} ${which} that tripped --fail-on ${formatClause(tripped.clause)} (${byStatus.join(", ")}).`
}

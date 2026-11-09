import type { SymbolChange } from "./generated/diff"
import type { Symbol as IRSymbol } from "./generated/ir"

/**
 * The head's Symbol for a pair. The report files an entry under it and the gate judges the entry
 * by it, so the two agree only while both read it here.
 */
export function representativeSymbol(change: SymbolChange): IRSymbol {
  return "symbol" in change ? change.symbol : change.after
}

export type SymbolChangeStatus = SymbolChange["status"]

// A Record, so that a status the schema adds and this list lacks is a compile error.
const STATUS_ORDER: Record<SymbolChangeStatus, null> = {
  added: null,
  removed: null,
  changed: null,
  moved: null,
  "moved+changed": null,
  "dropped-toggled": null,
  unknown: null,
}

/** Every `SymbolChange` status, in the order reports name them. */
export const SYMBOL_CHANGE_STATUSES: readonly SymbolChangeStatus[] = Object.freeze(
  Object.keys(STATUS_ORDER) as SymbolChangeStatus[],
)

export function isSymbolChangeStatus(value: unknown): value is SymbolChangeStatus {
  return typeof value === "string" && Object.hasOwn(STATUS_ORDER, value)
}

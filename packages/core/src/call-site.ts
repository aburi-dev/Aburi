import type { SymbolId, ThisBinding } from "@aburi/types"

export const CALL_SITE_KEY_SEPARATOR = "\t"

export function dependencyKey(from: string, to: string, via: string): string {
  return [from, to, via].join(CALL_SITE_KEY_SEPARATOR)
}

export function callEdgeKey(from: string, to: string): string {
  return [from, to].join(CALL_SITE_KEY_SEPARATOR)
}

export function makeCallSiteKey(file: string, line: number, target: string): string {
  return [file, line, target].join(CALL_SITE_KEY_SEPARATOR)
}

// By the calling Symbol rather than the file, so two classes written on one line stay apart.
export function makeSymbolCallKey(symbol: string, line: number, target: string): string {
  return [symbol, line, target].join(CALL_SITE_KEY_SEPARATOR)
}

/** A call's `makeSymbolCallKey` and the named type its receiver is declared with. */
export type DeclaredReceiverType = readonly [key: string, type: string]

/**
 * By `makeSymbolCallKey`: the named type each call's receiver is declared with. A key whose calls
 * do not all name one type is left out, since which call a type was written for is lost.
 */
export type DeclaredReceiverTypes = ReadonlyMap<string, string>

/**
 * A class that extends another: the name its `extends` writes, bound where the class is declared,
 * and the instance members it declares itself, a Symbol or not, which hide the ones it inherits.
 */
export interface ClassHeritage {
  readonly superclass: string
  readonly instanceMembers: readonly string[]
}

/** By class Symbol id: what each class that extends another extends. */
export type ClassHeritages = ReadonlyMap<SymbolId, ClassHeritage>

export type ClassHeritageEntry = readonly [classId: SymbolId, heritage: ClassHeritage]

/** By variable Symbol id: the named type its module declares its value with. */
export type ValueTypes = ReadonlyMap<SymbolId, string>

export type ValueTypeEntry = readonly [variableId: SymbolId, type: string]

export function receiverHead(target: string): string | undefined {
  return target.split(".").find((segment) => segment.length > 0)
}

/**
 * Call-site keys by what `this` is where the call is written. A key in both sets stands for calls
 * on both sides and gets no side.
 */
export type ThisBindingSites = Readonly<Record<ThisBinding, ReadonlySet<string>>>

export type CallSiteBinding = readonly [key: string, binding: ThisBinding]

export const NO_THIS_BINDINGS: ThisBindingSites = { class: new Set(), instance: new Set() }

// One key can stand for calls written on both sides, which a hint keyed by it cannot tell apart.
export function thisBindingOfSite(sites: ThisBindingSites, key: string): ThisBinding | null {
  const onClass = sites.class.has(key)
  if (onClass === sites.instance.has(key)) return null
  return onClass ? "class" : "instance"
}

export function isThisBinding(value: unknown): value is ThisBinding {
  return value === "class" || value === "instance"
}

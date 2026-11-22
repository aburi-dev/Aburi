import type { CallSiteRef, SymbolId, ThisBinding } from "@aburi/types"

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

/**
 * What a call of a function gives back: a `type` by name, bound where the function is declared;
 * the value of the call written there at a `makeCallSiteKey`; or what a call of the function a
 * `reference` names there gives back.
 */
export type ReturnSource =
  | { readonly type: string }
  | { readonly callSite: string }
  | { readonly reference: string }

/** By function or variable Symbol id: what a call of it gives back. */
export type ReturnSources = ReadonlyMap<SymbolId, ReturnSource>

export type ReturnSourceEntry = readonly [symbolId: SymbolId, returns: ReturnSource]

/**
 * By `makeSymbolCallKey`: the `makeCallSiteKey` of the call whose result each call's receiver is. A
 * key whose calls do not all name one call is left out.
 */
export type ReceiverCalls = ReadonlyMap<string, string>

export type ReceiverCallEntry = readonly [key: string, callSite: string]

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

// A plugin outside the tree may write anything, and a call it names is only a hint.
export function isCallSiteRef(value: unknown): value is CallSiteRef {
  if (typeof value !== "object" || value === null) return false
  const { target, line } = value as Partial<Record<keyof CallSiteRef, unknown>>
  return (
    typeof target === "string" && target.length > 0 && Number.isInteger(line) && Number(line) > 0
  )
}

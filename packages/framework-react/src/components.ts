import { unwrapValue } from "@aburi/core"
import {
  findReturnedJsxElementNames,
  findReturnedValues,
  hasJsxReturn,
  isProviderElementName,
} from "./jsx"

const FUNCTION_VALUE_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
])

/** The gate React itself uses to tell `<Foo />` from an HTML element. */
export function isPascalCase(leaf: string): boolean {
  if (leaf.length === 0) return false
  const first = leaf.charCodeAt(0)
  return first >= 0x41 && first <= 0x5a
}

export function matchesHocNaming(leaf: string): boolean {
  return /^with[A-Z]/.test(leaf)
}

/** A HOC hands back a component, so its body renders JSX or returns a function. */
export function hasHocBody(body: unknown): boolean {
  return (
    hasJsxReturn(body) ||
    findReturnedValues(body).some((value) => FUNCTION_VALUE_TYPES.has(unwrapValue(value).type))
  )
}

export function returnsContextProvider(body: unknown): boolean {
  return findReturnedJsxElementNames(body).some(isProviderElementName)
}

export function returnsJsx(body: unknown): boolean {
  return hasJsxReturn(body)
}

import type { ReturnedValue, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { hasChildOfType, throughParentheses } from "./ast-helpers"
import { callSiteOf } from "./callee"
import {
  constructedClass,
  initializingCall,
  instanceClassOf,
  nameTypeOf,
  returnAnnotationOf,
} from "./receiver-type"

const FUNCTIONS: ReadonlySet<string> = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
])

const SIGNATURES: ReadonlySet<string> = new Set(["function_signature", "method_signature"])

// A function or class written in the body returns from itself, not from the body.
const NESTED_SCOPES: ReadonlySet<string> = new Set([
  ...FUNCTIONS,
  "generator_function",
  "generator_function_declaration",
  "class",
  "class_declaration",
  "abstract_class_declaration",
])

export function returnedValueOf(candidate: SymbolCandidate<Node>): ReturnedValue | null {
  if (candidate.kind !== "function" && candidate.kind !== "method") return null
  const declarations = [
    candidate.fullNode,
    ...(candidate.mergedDeclarations ?? []).map((merged) => merged.fullNode),
  ]
  // A caller sees only the overloads, never the signature their implementation is written with.
  const overloads = declarations.filter((node) => SIGNATURES.has(node.type))
  if (overloads.length > 0) return sameReturned(overloads.map(returnAnnotationOf))
  const [fn, ...others] = declarations.filter((node) => FUNCTIONS.has(node.type))
  return fn === undefined || others.length > 0 ? null : returnedByFunction(fn)
}

// A call gives back one value only where every way the function returns names the same one.
function sameReturned(values: readonly (ReturnedValue | null)[]): ReturnedValue | null {
  const [first, ...others] = values
  if (first === undefined || first === null) return null
  return others.every((value) => value !== null && sameValue(value, first)) ? first : null
}

function sameValue(a: ReturnedValue, b: ReturnedValue): boolean {
  if (a.self === true || b.self === true) return a.self === b.self
  return a.type !== undefined && a.type === b.type
}

// An `async` function gives back a promise, a generator an iterator, and an accessor's call is a
// call of the value it reads.
function returnedByFunction(fn: Node): ReturnedValue | null {
  if (hasChildOfType(fn, "async") || hasChildOfType(fn, "*")) return null
  if (["get", "set"].some((keyword) => hasChildOfType(fn, keyword))) return null
  if (fn.childForFieldName("name")?.text === "constructor") return null
  if (fn.childForFieldName("return_type") !== null) return returnAnnotationOf(fn)
  const body = fn.childForFieldName("body")
  if (body === null) return null
  return body.type === "statement_block" ? returnedByBlock(body) : returnedByValue(body)
}

// A bare `return`, `null` or `undefined` leaves no value to call a member of.
function returnedByBlock(body: Node): ReturnedValue | null {
  const values = returnedValues(body).filter((value) => !isNullish(value))
  if (values.length === 1 && values[0] !== undefined) return returnedByValue(values[0])
  return sameReturned(values.map(returnedInstance))
}

function returnedByValue(written: Node): ReturnedValue | null {
  const value = throughParentheses(written)
  const held = value.type === "identifier" ? initializingCall(value) : null
  const call = value.type === "call_expression" ? value : held
  if (call !== null) {
    const site = callSiteOf(call)
    return site === null ? null : { call: site }
  }
  return returnedInstance(value)
}

// `this` in an instance member is the receiver, a value of the class or of a subclass.
function returnedInstance(written: Node): ReturnedValue | null {
  const value = throughParentheses(written)
  if (value.type === "this") return instanceClassOf(value) === null ? null : { self: true }
  const type =
    value.type === "new_expression"
      ? constructedClass(value)
      : value.type === "identifier"
        ? nameTypeOf(value)
        : null
  return type === null ? null : { type }
}

function returnedValues(body: Node): Node[] {
  const values: Node[] = []
  const visit = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (child === null || NESTED_SCOPES.has(child.type)) continue
      if (child.type === "return_statement") {
        const value = child.namedChildren.find((part) => part !== null && part.type !== "comment")
        if (value !== undefined && value !== null) values.push(value)
        continue
      }
      visit(child)
    }
  }
  visit(body)
  return values
}

function isNullish(written: Node): boolean {
  const value = throughParentheses(written)
  return value.type === "null" || value.type === "undefined"
}

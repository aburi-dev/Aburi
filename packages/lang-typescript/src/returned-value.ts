import type { ReturnedValue, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { hasChildOfType, throughParentheses } from "./ast-helpers"
import { callSiteOf } from "./callee"
import {
  constructedClass,
  initializingCall,
  instanceClassOf,
  nameTypeOf,
  returnAnnotationType,
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
  if (overloads.length > 0) return sameAnnotatedType(overloads)
  const [fn, ...others] = declarations.filter((node) => FUNCTIONS.has(node.type))
  return fn === undefined || others.length > 0 ? null : returnedByFunction(fn)
}

function sameAnnotatedType(signatures: readonly Node[]): ReturnedValue | null {
  const types = new Set(signatures.map(returnAnnotationType))
  const [type, ...others] = types
  return typeof type === "string" && others.length === 0 ? { type } : null
}

// An `async` function gives back a promise, a generator an iterator, and an accessor's call is a
// call of the value it reads.
function returnedByFunction(fn: Node): ReturnedValue | null {
  if (hasChildOfType(fn, "async") || hasChildOfType(fn, "*")) return null
  if (["get", "set"].some((keyword) => hasChildOfType(fn, keyword))) return null
  if (fn.childForFieldName("name")?.text === "constructor") return null
  if (fn.childForFieldName("return_type") !== null) {
    const type = returnAnnotationType(fn)
    return type === null ? null : { type }
  }
  const body = fn.childForFieldName("body")
  if (body === null) return null
  return body.type === "statement_block" ? returnedByBlock(body) : returnedByValue(body)
}

// A bare `return`, `null` or `undefined` leaves no value to call a member of.
function returnedByBlock(body: Node): ReturnedValue | null {
  const values = returnedValues(body).filter((value) => !isNullish(value))
  if (values.length === 1 && values[0] !== undefined) return returnedByValue(values[0])
  const types = new Set(values.map(typeOf))
  const [type, ...others] = types
  return typeof type === "string" && others.length === 0 ? { type } : null
}

function returnedByValue(written: Node): ReturnedValue | null {
  const value = throughParentheses(written)
  const held = value.type === "identifier" ? initializingCall(value) : null
  const call = value.type === "call_expression" ? value : held
  if (call !== null) {
    const site = callSiteOf(call)
    return site === null ? null : { call: site }
  }
  const type = typeOf(value)
  return type === null ? null : { type }
}

function typeOf(written: Node): string | null {
  const value = throughParentheses(written)
  switch (value.type) {
    case "this":
      return instanceClassOf(value)
    case "new_expression":
      return constructedClass(value)
    case "identifier":
      return nameTypeOf(value)
    default:
      return null
  }
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

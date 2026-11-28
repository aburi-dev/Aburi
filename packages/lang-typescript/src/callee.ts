import { decodeStringLiteral, isQnameSegment, readStaticString, receiverHead } from "@aburi/core"
import { type CallCandidate, type CallSiteRef, COMPUTED_TARGET_SEGMENT } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild, firstNonCommentChild, hasErrorChild, throughParentheses } from "./ast-helpers"
import { bindingOf, isModuleDeclaration } from "./name-binding"
import {
  initializingCall,
  isImportedReceiver,
  receiverTypeOf,
  thisBindingAt,
} from "./receiver-type"
import { type TypedTag, typedTagCalledBy, typedTagOf } from "./typed-tag"

/**
 * Where a walk records a call: a call, a `new`, and the template of a tagged template with type
 * arguments, which stands for a call the grammar spread over other nodes.
 */
export function isCallSite(node: Node): boolean {
  switch (node.type) {
    case "call_expression":
      return typedTagCalledBy(node) === null
    case "new_expression":
      return true
    case "template_string":
      return typedTagOf(node) !== null
    default:
      return false
  }
}

/** Where a walk records a call of a function, as `isCallSite` reads one. */
export function isFunctionCallSite(node: Node): boolean {
  return node.type !== "new_expression" && isCallSite(node)
}

interface CallParts {
  readonly callee: Node
  readonly argsNode: Node | null
  readonly inAwait: boolean
  readonly inNew: boolean
  /** Where the call TypeScript reads begins. */
  readonly start: Node
}

function callParts(node: Node): CallParts | null {
  switch (node.type) {
    case "template_string": {
      const typed = typedTagOf(node)
      return typed === null ? null : typedTagParts(typed)
    }
    case "call_expression": {
      const typed = typedTagCalledBy(node)
      return typed === null ? writtenParts(node, "function") : typedTagParts(typed)
    }
    case "new_expression":
      return writtenParts(node, "constructor")
    default:
      return null
  }
}

// What a call is made on, as `callParts` reads it, without the parent its `inAwait` asks the tree
// for: a callee is read down a chain, where each parent costs the chain's depth.
function calledFunction(call: Node): Node | null {
  return typedTagCalledBy(call)?.tag ?? call.childForFieldName("function") ?? call.namedChild(0)
}

function typedTagParts({ tag, template, awaited }: TypedTag): CallParts {
  return { callee: tag, argsNode: template, inAwait: awaited, inNew: false, start: tag }
}

function writtenParts(node: Node, calleeField: string): CallParts | null {
  const callee = node.childForFieldName(calleeField) ?? node.namedChild(0)
  if (callee === null) return null
  return {
    callee,
    argsNode: node.childForFieldName("arguments") ?? findChild(node, "arguments"),
    inAwait: node.parent?.type === "await_expression",
    inNew: node.type === "new_expression",
    start: node,
  }
}

export function readCall(node: Node): CallCandidate | null {
  const parts = isCallSite(node) ? callParts(node) : null
  if (parts === null) return null
  const { callee, argsNode } = parts
  const shape = describeCallee(callee)
  if (shape === null) return null
  const args = (argsNode?.namedChildren ?? []).filter(
    (arg): arg is Node => arg !== null && arg.type !== "comment",
  )
  const receiverType = receiverTypeOf(callee)
  const receiverCall = receiverType === null ? receiverCallOf(callee) : null
  const thisBinding = THIS_RECEIVERS.has(receiverHead(shape.target) ?? "")
    ? thisBindingAt(node)
    : null
  return {
    target: shape.target,
    line: parts.start.startPosition.row + 1,
    argumentCount: args.length,
    inAwait: parts.inAwait,
    inNew: parts.inNew,
    literalArgs: args.map(literalOf),
    ...(shape.dynamic ? { dynamicReceiver: true } : {}),
    ...(receiverType === null ? {} : { receiverType }),
    ...(isImportedReceiver(callee) ? { importedReceiver: true } : {}),
    ...(receiverCall === null ? {} : { receiverCall }),
    ...(isUnboundHead(callee) ? { unboundHead: true } : {}),
    ...(isLocalHead(callee) ? { localHead: true } : {}),
    ...(thisBinding === null ? {} : { thisBinding }),
  }
}

const THIS_RECEIVERS: ReadonlySet<string> = new Set(["this", "super"])

function receiverCallOf(callee: Node): CallSiteRef | null {
  if (callee.type !== "member_expression") return null
  const receiver = callee.childForFieldName("object")
  if (receiver?.type === "call_expression" || receiver?.type === "template_string") {
    return callSiteOf(receiver)
  }
  const call = receiver?.type === "identifier" ? initializingCall(receiver) : null
  return call === null ? null : callSiteOf(call)
}

// CommonJS hands each module its own `module` and `exports`, and `require(…)` gives back another
// module's exports, any of which may be the workspace's.
const MODULE_WRAPPER_NAMES: ReadonlySet<string> = new Set(["module", "exports"])

function isUnboundHead(callee: Node): boolean {
  const head = leadingName(callee)
  if (head === null || bindingOf(head, head.text) !== null) return false
  if (MODULE_WRAPPER_NAMES.has(head.text)) return false
  return head.text !== "require" || head.id === callee.id
}

function isLocalHead(callee: Node): boolean {
  const head = leadingName(callee)
  if (head === null) return false
  const binding = bindingOf(head, head.text)
  return binding !== null && !isModuleDeclaration(binding, head.text)
}

// The name the target spells first, read down the chain as `describeCallee` reads it.
function leadingName(callee: Node): Node | null {
  let node: Node | null = callee
  while (node !== null) {
    switch (node.type) {
      case "identifier":
        return node
      case "member_expression":
      case "subscript_expression":
        node = node.childForFieldName("object")
        break
      case "call_expression":
        node = calledFunction(node)
        break
      case "template_string":
        node = typedTagOf(node)?.tag ?? null
        break
      case "parenthesized_expression":
        node = parenthesizedReceiver(node)
        break
      case "as_expression":
      case "satisfies_expression":
      case "type_assertion":
      case "instantiation_expression":
      case "non_null_expression":
        node = wrappedExpression(node)
        break
      default:
        return null
    }
  }
  return null
}

export function callSiteOf(call: Node): CallSiteRef | null {
  const parts = callParts(call)
  const shape = parts === null ? null : describeCallee(parts.callee)
  if (parts === null || shape === null) return null
  return { target: shape.target, line: parts.start.startPosition.row + 1 }
}

function literalOf(node: Node): string | null {
  switch (node.type) {
    case "number":
    case "true":
    case "false":
    case "null":
    case "undefined":
      return node.text
    case "string":
    case "template_string":
      return readStaticString(node)
    default:
      return null
  }
}

interface CalleeShape {
  readonly target: string
  readonly dynamic: boolean
  readonly opaque: boolean
}

const UNMODELLED_EXPRESSION: CalleeShape = {
  target: COMPUTED_TARGET_SEGMENT,
  dynamic: true,
  opaque: false,
}

const META_PROPERTIES: ReadonlySet<string> = new Set(["import.meta", "new.target"])

export function wrappedExpression(node: Node): Node | null {
  return node.type === "type_assertion"
    ? (node.namedChildren.at(-1) ?? null)
    : firstNonCommentChild(node)
}

export function describeCallee(node: Node): CalleeShape | null {
  switch (node.type) {
    case "identifier":
    case "property_identifier":
      return { target: node.text, dynamic: false, opaque: false }
    case "this":
      return { target: "this", dynamic: false, opaque: false }
    case "super":
      return { target: "super", dynamic: false, opaque: false }
    case "import":
      return { target: "import", dynamic: false, opaque: false }
    case "meta_property":
      return META_PROPERTIES.has(node.text)
        ? { target: node.text, dynamic: false, opaque: false }
        : UNMODELLED_EXPRESSION
    case "member_expression": {
      const object = node.childForFieldName("object")
      const property = node.childForFieldName("property")
      const objectShape = object !== null ? describeCallee(object) : null
      const propertyStr = property !== null ? property.text : null
      if (objectShape === null || propertyStr === null) return null
      return {
        target: `${objectShape.target}.${propertyStr}`,
        dynamic: objectShape.dynamic,
        opaque: objectShape.opaque,
      }
    }
    case "subscript_expression": {
      const object = node.childForFieldName("object")
      if (object === null) return null
      const inner = describeCallee(object)
      if (inner === null) return null
      const segment = subscriptSegment(node)
      if (segment === null) {
        return {
          target: `${inner.target}.${COMPUTED_TARGET_SEGMENT}`,
          dynamic: true,
          opaque: false,
        }
      }
      return {
        target: `${inner.target}.${segment}`,
        dynamic: inner.dynamic,
        opaque: inner.opaque,
      }
    }
    case "parenthesized_expression": {
      const innerNode = parenthesizedReceiver(node)
      if (innerNode === null) return null
      const inner = describeCallee(innerNode)
      if (inner === null) return null
      return { target: inner.target, dynamic: inner.dynamic || inner.opaque, opaque: false }
    }
    case "call_expression":
      return describeResultOf(calledFunction(node))
    case "template_string": {
      const typed = typedTagOf(node)
      return typed === null ? UNMODELLED_EXPRESSION : describeResultOf(typed.tag)
    }
    case "as_expression":
    case "satisfies_expression":
    case "type_assertion":
    case "instantiation_expression": {
      const innerNode = wrappedExpression(node)
      return innerNode === null ? null : describeCallee(innerNode)
    }
    case "non_null_expression":
      return describeNonNull(node)
    default:
      return node.text.length > 0 ? UNMODELLED_EXPRESSION : null
  }
}

// What a call gives back is known only at run time, so a receiver read off it is dynamic.
function describeResultOf(callee: Node | null): CalleeShape | null {
  const inner = callee === null ? null : describeCallee(callee)
  return inner === null ? null : { target: inner.target, dynamic: true, opaque: false }
}

// A pair holding more than its expression is read by its first fragment, the part its receiver
// parsed as.
function parenthesizedReceiver(node: Node): Node | null {
  const inner = throughParentheses(node)
  return inner.type === "parenthesized_expression" ? firstNonCommentChild(inner) : inner
}

function describeNonNull(node: Node): CalleeShape | null {
  const innerNode = wrappedExpression(node)
  if (innerNode === null) return null
  const inner = describeCallee(innerNode)
  if (inner === null) return null
  // A `!` the grammar inserted asserts nothing the source wrote.
  if (node.lastChild?.isMissing === true) return inner
  if (inner.dynamic) return { target: inner.target, dynamic: true, opaque: false }
  return { target: `${inner.target}!`, dynamic: false, opaque: true }
}

function subscriptSegment(node: Node): string | null {
  if (hasErrorChild(node)) return null
  const index = node.childForFieldName("index")
  if (index === null) return null
  if (index.type !== "string" && index.type !== "template_string") return null
  const { value, whole } = decodeStringLiteral(index)
  return whole && isQnameSegment(value) ? value : null
}

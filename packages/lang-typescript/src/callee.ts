import { decodeStringLiteral, isQnameSegment, readStaticString, receiverHead } from "@aburi/core"
import { type CallCandidate, type CallSiteRef, COMPUTED_TARGET_SEGMENT } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { findChild, firstNonCommentChild, hasErrorChild, throughParentheses } from "./ast-helpers"
import { bindingOf } from "./name-binding"
import {
  initializingCall,
  isImportedReceiver,
  receiverTypeOf,
  thisBindingAt,
} from "./receiver-type"

export function readCall(node: Node): CallCandidate | null {
  const isNew = node.type === "new_expression"
  const callee = node.childForFieldName(isNew ? "constructor" : "function") ?? node.namedChild(0)
  if (callee === null) return null
  const shape = describeCallee(callee)
  if (shape === null) return null
  const argsNode = node.childForFieldName("arguments") ?? findChild(node, "arguments")
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
    line: node.startPosition.row + 1,
    argumentCount: args.length,
    inAwait: node.parent?.type === "await_expression",
    inNew: isNew,
    literalArgs: args.map(literalOf),
    ...(shape.dynamic ? { dynamicReceiver: true } : {}),
    ...(receiverType === null ? {} : { receiverType }),
    ...(isImportedReceiver(callee) ? { importedReceiver: true } : {}),
    ...(receiverCall === null ? {} : { receiverCall }),
    ...(isUnboundHead(callee) ? { unboundHead: true } : {}),
    ...(thisBinding === null ? {} : { thisBinding }),
  }
}

const THIS_RECEIVERS: ReadonlySet<string> = new Set(["this", "super"])

function receiverCallOf(callee: Node): CallSiteRef | null {
  if (callee.type !== "member_expression") return null
  const receiver = callee.childForFieldName("object")
  if (receiver?.type === "call_expression") return callSiteOf(receiver)
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
        node = node.childForFieldName("function")
        break
      case "parenthesized_expression":
        node = parenthesizedReceiver(node)
        break
      case "as_expression":
      case "satisfies_expression":
      case "type_assertion":
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
  const callee = call.childForFieldName("function") ?? call.namedChild(0)
  const shape = callee === null ? null : describeCallee(callee)
  return shape === null ? null : { target: shape.target, line: call.startPosition.row + 1 }
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
    case "call_expression": {
      const innerNode = node.childForFieldName("function")
      if (innerNode === null) return null
      const inner = describeCallee(innerNode)
      if (inner === null) return null
      return { target: inner.target, dynamic: true, opaque: false }
    }
    case "as_expression":
    case "satisfies_expression":
    case "type_assertion": {
      const innerNode = wrappedExpression(node)
      return innerNode === null ? null : describeCallee(innerNode)
    }
    case "non_null_expression":
      return describeNonNull(node)
    default:
      return node.text.length > 0 ? UNMODELLED_EXPRESSION : null
  }
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

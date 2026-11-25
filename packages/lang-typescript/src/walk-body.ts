import type {
  BodyExtraction,
  CallCandidate,
  Rule,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { bodyNodesOf, firstNonCommentChild, throughParentheses, thrownValue } from "./ast-helpers"
import { readCall } from "./callee"
import {
  functionValuedField,
  heldFunctionBodies,
  isConstructorMember,
  memberSymbolSegment,
} from "./class-members"
import { containsEarlyExit, type ExitCalls, NO_EXIT_CALLS } from "./early-exit"
import { objectEntryOf } from "./object-members"
import { conditionText, isTrivialExpr, LOOP_KINDS, makeRule, ruleText } from "./rules"

export function walkBody(symbol: SymbolCandidate<Node>, ctx: WalkContext<Node>): BodyExtraction {
  const walk: Walk = { rules: [], calls: [], exitCalls: ctx.registry }
  for (const { root, held } of nestedBodies(bodyNodesOf(symbol))) {
    if (held.length === 0) visitRoot(root, walk)
    else visitHolding(root, holdingOf(root, held), walk)
  }
  const { rules, calls } = walk
  rules.sort((a, b) => a.line - b.line)
  calls.sort((a, b) => a.line - b.line)
  return { rules, calls }
}

interface Walk {
  readonly rules: Rule[]
  readonly calls: CallCandidate[]
  readonly exitCalls: ExitCalls
}

interface NestedBodies {
  readonly root: Node
  readonly held: Node[]
}

// Two nodes of one tree either nest or do not meet, so ordered by where they start, a body is held
// by the last root it ends inside. Comparing ranges rather than walking up from every body keeps a
// `<module>` of many statements, or a const chaining many handlers, linear.
function nestedBodies(bodies: readonly Node[]): NestedBodies[] {
  const spans = bodies
    .map((node, order) => ({ node, order, start: node.startIndex, end: node.endIndex }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order)
  const roots: (NestedBodies & { readonly end: number; readonly order: number })[] = []
  for (const { node, order, start, end } of spans) {
    const last = roots.at(-1)
    if (last !== undefined && start < last.end && node.id !== last.root.id) last.held.push(node)
    else roots.push({ root: node, held: [], end, order })
  }
  return roots.sort((a, b) => a.order - b.order)
}

interface Holding {
  readonly bodies: ReadonlyMap<number, Node>
  /** The held bodies' parameter lists, left to `visitRoot`, which reads their defaults with the body. */
  readonly parameterLists: ReadonlySet<number>
  /** Every node between the root and a body it holds. */
  readonly spine: ReadonlySet<number>
}

function holdingOf(root: Node, held: readonly Node[]): Holding {
  const spine = new Set<number>()
  for (const body of held) {
    for (let node = body.parent; node !== null; node = node.parent) {
      if (node.id === root.id || spine.has(node.id)) break
      spine.add(node.id)
    }
  }
  return {
    bodies: new Map(held.map((body) => [body.id, body])),
    parameterLists: new Set(held.flatMap((body) => parametersOf(body)?.id ?? [])),
    spine,
  }
}

function visitRoot(body: Node, walk: Walk): void {
  const owner = body.type === "class_body" ? body.parent : null
  if (owner !== null) {
    visitOwnClassBody(owner, body, walk)
    return
  }
  if (body.type === "object") {
    visitOwnObjectBody(body, walk)
    return
  }
  const parameters = parametersOf(body)
  if (parameters !== null) visitParameterDefaults(parameters, walk)
  if (isConciseBody(body)) visitConciseBody(body, walk)
  else visitNode(body, walk)
}

// A body held by another is read as a function of its own where it is written, so the calls on a
// line keep the order they are written in.
function visitHolding(node: Node, holding: Holding, walk: Walk): void {
  if (isCall(node)) recordCall(node, walk.calls)
  for (const part of node.namedChildren) {
    if (part === null || holding.parameterLists.has(part.id)) continue
    const body = holding.bodies.get(part.id)
    if (body !== undefined) visitRoot(body, walk)
    else if (holding.spine.has(part.id)) visitHolding(part, holding, walk)
    else visitNode(part, walk)
  }
}

function parametersOf(body: Node): Node | null {
  return body.parent?.childForFieldName("parameters") ?? null
}

export function parameterDefaultsRecordAnything(body: Node): boolean {
  const parameters = parametersOf(body)
  if (parameters === null) return false
  // An exit call is itself a recorded call, so the answer does not depend on which calls exit.
  const walk: Walk = { rules: [], calls: [], exitCalls: NO_EXIT_CALLS }
  visitParameterDefaults(parameters, walk)
  return walk.rules.length > 0 || walk.calls.length > 0
}

function visitParameterDefaults(parameters: Node, walk: Walk): void {
  for (const parameter of parameters.namedChildren) {
    if (parameter === null) continue
    for (const part of parameter.namedChildren) {
      if (part !== null && part.type !== "decorator") visitNode(part, walk)
    }
  }
}

function visitOwnClassBody(classNode: Node, body: Node, walk: Walk): void {
  for (const member of body.namedChildren) {
    if (member === null) continue
    const memberBodies = memberBodiesSkippedHere(classNode, member)
    if (memberBodies.length === 0) {
      visitNode(member, walk)
      continue
    }
    const parameterLists = memberBodies.flatMap(
      (memberBody) => memberBody.parent?.childForFieldName("parameters") ?? [],
    )
    visitExcluding(member, [...memberBodies, ...parameterLists], walk)
    for (const parameters of parameterLists) visitParameterDecorators(parameters, walk)
  }
}

function visitOwnObjectBody(object: Node, walk: Walk): void {
  for (const entry of object.namedChildren) {
    if (entry === null) continue
    const read = objectEntryOf(entry)
    if (read === null) {
      visitNode(entry, walk)
      continue
    }
    if (read.object !== null) {
      visitExcluding(entry, [read.object], walk)
      visitOwnObjectBody(read.object, walk)
      continue
    }
    const skipped = [
      read.fn.childForFieldName("body"),
      read.fn.childForFieldName("parameters"),
    ].filter((node): node is Node => node !== null)
    visitExcluding(entry, skipped, walk)
  }
}

function visitExcluding(node: Node, skipped: readonly Node[], walk: Walk): void {
  for (const part of node.namedChildren) {
    if (part === null || skipped.some((s) => s.id === part.id)) continue
    if (!skipped.some((s) => isAncestorOf(part, s))) {
      visitNode(part, walk)
      continue
    }
    // Calls a skipped body sits under run on the owner; only the body waits for the member's call.
    if (part.type === "call_expression") recordCall(part, walk.calls)
    visitExcluding(part, skipped, walk)
  }
}

function visitParameterDecorators(parameters: Node, walk: Walk): void {
  for (const parameter of parameters.namedChildren) {
    if (parameter === null) continue
    for (const part of parameter.namedChildren) {
      if (part !== null && part.type === "decorator") visitNode(part, walk)
    }
  }
}

function isAncestorOf(node: Node, descendant: Node): boolean {
  for (let parent = descendant.parent; parent !== null; parent = parent.parent) {
    if (parent.id === node.id) return true
  }
  return false
}

function memberBodiesSkippedHere(classNode: Node, member: Node): Node[] {
  if (memberSymbolSegment(classNode, member) === null) return []
  if (isConstructorMember(member)) return []
  const held = functionValuedField(member)
  if (held !== null) return heldFunctionBodies(held)
  const body = member.childForFieldName("body")
  return body === null ? [] : [body]
}

function visitNode(node: Node, walk: Walk): void {
  const loopKind = LOOP_KINDS.get(node.type)
  if (loopKind !== undefined) {
    walk.rules.push(makeRule("loop", node, { loopKind }))
    visitChildren(node, walk)
    return
  }
  switch (node.type) {
    case "if_statement":
      visitIfStatement(node, walk)
      return
    case "throw_statement": {
      const thrown = thrownValue(node)
      walk.rules.push(
        makeRule("throw", node, { what: thrown === null ? null : ruleText(thrown.node) }),
      )
      visitCallsInside(node, walk.calls)
      return
    }
    case "return_statement":
      visitReturnStatement(node, walk)
      return
    case "try_statement":
      walk.rules.push(makeRule("try", node))
      visitTryStatement(node, walk)
      return
    case "switch_statement":
      walk.rules.push(makeRule("switch", node, { condition: switchCondition(node) }))
      visitChildren(node, walk)
      return
    case "call_expression":
    case "new_expression":
      recordCall(node, walk.calls)
      visitChildren(node, walk)
      return
    default:
      visitChildren(node, walk)
      return
  }
}

function visitChildren(node: Node, walk: Walk): void {
  for (const child of node.namedChildren) {
    if (child === null) continue
    visitNode(child, walk)
  }
}

function recordCall(node: Node, calls: CallCandidate[]): void {
  const call = readCall(node)
  if (call !== null) calls.push(call)
}

function visitCallsInside(node: Node, calls: CallCandidate[]): void {
  for (const child of node.namedChildren) {
    if (child === null) continue
    if (isCall(child)) recordCall(child, calls)
    visitCallsInside(child, calls)
  }
}

function visitIfStatement(node: Node, walk: Walk): void {
  const consequence = node.childForFieldName("consequence")
  if (consequence !== null && containsEarlyExit(consequence, walk.exitCalls)) {
    const condition = node.childForFieldName("condition")
    walk.rules.push(
      makeRule("guard", node, {
        condition: condition !== null ? conditionText(condition) : null,
      }),
    )
  }
  visitChildren(node, walk)
}

function visitReturnStatement(node: Node, walk: Walk): void {
  const written = firstNonCommentChild(node)
  if (written === null) return
  const value = throughParentheses(written)
  if (isCall(value)) {
    recordCall(value, walk.calls)
    visitChildren(value, walk)
    return
  }
  if (isTrivialExpr(value)) return
  walk.rules.push(makeRule("return", node, { expr: ruleText(value) }))
  visitChildren(value, walk)
}

function visitConciseBody(body: Node, walk: Walk): void {
  const value = throughParentheses(body)
  if (!isCall(value) && !isTrivialExpr(value)) {
    walk.rules.push(makeRule("return", body, { expr: ruleText(value) }))
  }
  visitNode(body, walk)
}

function isConciseBody(body: Node): boolean {
  return body.parent?.type === "arrow_function" && body.type !== "statement_block"
}

function isCall(node: Node): boolean {
  return node.type === "call_expression" || node.type === "new_expression"
}

function visitTryStatement(node: Node, walk: Walk): void {
  const body = node.childForFieldName("body")
  if (body !== null) visitNode(body, walk)
  const handler = node.childForFieldName("handler")
  const withheld: Walk = { ...walk, rules: [] }
  if (handler !== null) visitNode(handler, withheld)
  const finalizer = node.childForFieldName("finalizer")
  if (finalizer !== null) visitNode(finalizer, walk)
}

function switchCondition(node: Node): string | null {
  const cond = node.childForFieldName("value") ?? node.childForFieldName("condition")
  return cond !== null ? conditionText(cond) : null
}

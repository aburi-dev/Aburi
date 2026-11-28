import { unwrapValue } from "@aburi/core"
import type { Node, Tree } from "web-tree-sitter"

/**
 * A tagged template with type arguments, `` tag<T>`…` ``, which TypeScript reads as a call of
 * `tag`. The grammar has no such form and spreads it over whatever its tokens parse as: an
 * instantiation completed with a `!` the source does not hold, comparisons, a shift, a union or a
 * sequence, or, at the end of a concise arrow's body, the arrow called with the template.
 */
export interface TypedTag {
  /** The expression the type arguments follow. */
  readonly tag: Node
  /** The `<` the type arguments open with. */
  readonly opening: Node
  readonly template: Node
  /** Whether the call is awaited: the grammar puts an `await` written before the tag on the tag. */
  readonly awaited: boolean
  /** The concise arrow the grammar ended before the template, whose body TypeScript runs it in. */
  readonly arrow: Node | null
}

/** Marks a tree parsed from a JavaScript file, where `a < b > `…`` is the comparisons it reads as. */
export function rememberJavaScript(tree: Tree): void {
  JAVASCRIPT_TREES.add(tree)
  READINGS.delete(tree)
}

const JAVASCRIPT_TREES = new WeakSet<Tree>()

/**
 * Whether `node` lies in the type arguments of a typed tag the grammar read as operators, where the
 * angles are the list's and the grouping it gives what is written between them is not the program's.
 */
export function inSplitTypeArguments(node: Node): boolean {
  const spans = readingsOf(node.tree).splitSpans
  let low = 0
  let high = spans.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [from, to] = spans[middle] ?? [0, 0]
    if (node.startIndex < from) high = middle - 1
    else if (node.endIndex > to) low = middle + 1
    else return true
  }
  return false
}

type Span = readonly [from: number, to: number]

/**
 * The typed tags of a tree, found once per tree: a callee is read down a chain, and each parent a
 * reading asks the tree for costs the chain's depth.
 */
interface Readings {
  readonly byTemplate: ReadonlyMap<number, TypedTag>
  /** By the id of a call the grammar made of a typed tag's template, the typed tag. */
  readonly byCall: ReadonlyMap<number, TypedTag>
  readonly splitSpans: readonly Span[]
  /** By the id of each node of a chain the grammar built around a concise arrow, that arrow. */
  readonly arrowOnChain: ReadonlyMap<number, Node>
  /** By a concise arrow's id, the top of the chain its body runs to. */
  readonly chainTopOfArrow: ReadonlyMap<number, Node>
}

const READINGS = new WeakMap<Tree, Readings>()

function readingsOf(tree: Tree): Readings {
  const cached = READINGS.get(tree)
  if (cached !== undefined) return cached
  const byTemplate = new Map<number, TypedTag>()
  const byCall = new Map<number, TypedTag>()
  const splitSpans: Span[] = []
  const arrowOnChain = new Map<number, Node>()
  const chainTopOfArrow = new Map<number, Node>()
  for (const template of tree.rootNode.descendantsOfType("template_string")) {
    const typed = template === null ? null : readTypedTag(template)
    if (typed === null) continue
    byTemplate.set(template.id, typed)
    const call = template.parent
    if (call !== null && calleeCalledWith(call, template) !== null) byCall.set(call.id, typed)
    if (typed.opening.parent?.type !== "type_arguments") {
      splitSpans.push([typed.opening.startIndex, typed.template.startIndex])
    }
    if (typed.arrow === null) continue
    const top = typedTagChainTop(typed)
    chainTopOfArrow.set(typed.arrow.id, top)
    for (let node = template.parent; node !== null; node = node.parent) {
      arrowOnChain.set(node.id, typed.arrow)
      if (node.id === top.id) break
    }
  }
  const readings = { byTemplate, byCall, splitSpans, arrowOnChain, chainTopOfArrow }
  READINGS.set(tree, readings)
  return readings
}

export function typedTagOf(template: Node): TypedTag | null {
  return readingsOf(template.tree).byTemplate.get(template.id) ?? null
}

/** The typed tag a call stands in for, where the grammar read its template as the call's argument. */
export function typedTagCalledBy(call: Node): TypedTag | null {
  return readingsOf(call.tree).byCall.get(call.id) ?? null
}

function readTypedTag(template: Node): TypedTag | null {
  if (JAVASCRIPT_TREES.has(template.tree)) return null
  const opening = typeArgumentsOpening(template)
  const tag = opening === null ? null : tagBefore(opening)
  if (opening === null || tag === null) return null
  const call = template.parent
  const callee = call === null ? null : calleeCalledWith(call, template)
  const arrow = callee?.type === "arrow_function" ? callee : null
  const typed = { tag, opening, template, awaited: false, arrow }
  const awaitsCall = callee !== null && arrow === null && call?.parent?.type === "await_expression"
  return { ...typed, awaited: tagAwait(typed) !== null || awaitsCall }
}

/** The last node of the chain written on the typed tag's result, or what stands for the call. */
export function typedTagChainTop(typed: TypedTag): Node {
  const { template } = typed
  const call = template.parent
  let node = call !== null && calleeCalledWith(call, template) !== null ? call : template
  for (let parent = node.parent; parent !== null; node = parent, parent = parent.parent) {
    const field = CHAIN_FIELDS.get(parent.type)
    if (field === undefined || parent.childForFieldName(field)?.equals(node) !== true) break
  }
  return node
}

/**
 * The node standing for the call TypeScript reads `value` as: a call, the template of a typed tag
 * the grammar spread over operators, or the call of a chain written on one.
 */
export function callOf(value: Node): Node | null {
  if (arrowReadingOf(value) !== null) return null
  const typed = typedTagBelow(lastOfSplit(value))
  if (typed === null) return value.type === "call_expression" ? value : null
  return spans(value, typed) && tagAwait(typed) === null ? chainCall(typed) : null
}

/** The call an `await` waits on, as `callOf` reads it. */
export function awaitedCallOf(value: Node): Node | null {
  if (value.type === "await_expression") {
    const operand = firstWrittenChild(value)
    return operand === null ? null : callOf(unwrapValue(operand))
  }
  const typed = typedTagBelow(lastOfSplit(value))
  return typed !== null && spans(value, typed) && tagAwait(typed) !== null ? chainCall(typed) : null
}

function chainCall(typed: TypedTag): Node | null {
  const top = typedTagChainTop(typed)
  return top.type === "call_expression" || top.type === "template_string" ? top : null
}

// The grammar binds an `await` written before the tag to the tag alone.
function tagAwait({ tag }: TypedTag): Node | null {
  const awaiting = tag.parent
  return awaiting?.type === "await_expression" && awaiting.endIndex === tag.endIndex
    ? awaiting
    : null
}

// Where the grammar bound an operator into the tag (`a + sql<T>\`…\``), no node is the call.
function spans(node: Node, typed: TypedTag): boolean {
  const start = tagAwait(typed) ?? typed.tag
  const top = typedTagChainTop(typed)
  return node.startIndex === start.startIndex && node.endIndex === top.endIndex
}

// The right operand the grammar read a typed tag's template into, through a union or a sequence.
function lastOfSplit(node: Node): Node {
  let last = node
  while (SPLITTING_TYPES.has(last.type)) {
    const next = lastWrittenChild(last)
    if (next === null) return last
    last = next
  }
  return last
}

function typedTagBelow(node: Node): TypedTag | null {
  for (let at: Node | null = node; at !== null; ) {
    if (at.type === "template_string") return typedTagOf(at)
    const typed = typedTagCalledBy(at)
    if (typed !== null) return typed
    const field = CHAIN_FIELDS.get(at.type)
    at = field === undefined ? null : at.childForFieldName(field)
  }
  return null
}

/** The concise arrow `node` is, where the grammar ended its body before a typed tag's template. */
export function arrowReadingOf(node: Node): Node | null {
  const readings = readingsOf(node.tree)
  const arrow = readings.arrowOnChain.get(node.id)
  if (arrow === undefined) return null
  return readings.chainTopOfArrow.get(arrow.id)?.id === node.id ? arrow : null
}

/** The node that spans an arrow's body, through a typed tag's template the grammar left outside. */
export function arrowBodyTop(arrow: Node): Node | null {
  return readingsOf(arrow.tree).chainTopOfArrow.get(arrow.id) ?? null
}

/**
 * The concise arrow whose body TypeScript reads `child` as part of, where `node` is on the chain the
 * grammar built around that arrow and `child` is not the arrow itself.
 */
export function arrowAround(node: Node, child: Node): Node | null {
  const arrow = readingsOf(node.tree).arrowOnChain.get(node.id)
  return arrow === undefined || arrow.id === child.id ? null : arrow
}

const CHAIN_FIELDS: ReadonlyMap<string, string> = new Map([
  ["member_expression", "object"],
  ["subscript_expression", "object"],
  ["call_expression", "function"],
])

function calleeCalledWith(call: Node, template: Node | null): Node | null {
  if (call.type !== "call_expression" || template === null) return null
  if (call.childForFieldName("arguments")?.equals(template) !== true) return null
  return call.childForFieldName("function")
}

// The grammar reads `tag < A | B > \`…\`` and `tag < A, B > \`…\`` around a union and a sequence.
const SPLITTING_TYPES: ReadonlySet<string> = new Set(["binary_expression", "sequence_expression"])

function lastWrittenChild(node: Node): Node | null {
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const child = node.namedChild(i)
    if (child !== null && child.type !== "comment") return child
  }
  return null
}

function firstWrittenChild(node: Node): Node | null {
  return node.namedChildren.find((child) => child !== null && child.type !== "comment") ?? null
}

const CLOSING_ANGLES: ReadonlyMap<string, number> = new Map([
  [">", 1],
  [">>", 2],
  [">>>", 3],
])

const BRACKETS: ReadonlyMap<string, string> = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
])

const CLOSING_BRACKETS: ReadonlySet<string> = new Set(BRACKETS.values())

function typeArgumentsOpening(template: Node): Node | null {
  return instantiationOpening(template) ?? balancedOpening(template)
}

// Where the grammar read the type arguments as types, in an instantiation it completed with a `!`
// or ended a concise arrow's body with, their list is its own.
function instantiationOpening(template: Node): Node | null {
  const call = template.parent
  const callee = call === null ? null : calleeCalledWith(call, template)
  const instantiation =
    callee?.type === "arrow_function"
      ? callee.childForFieldName("body")
      : callee?.type === "non_null_expression" && callee.lastChild?.isMissing === true
        ? firstWrittenChild(callee)
        : null
  if (instantiation?.type !== "instantiation_expression") return null
  return instantiation.childForFieldName("type_arguments")?.firstChild ?? null
}

// Read backwards from the template, the `<` the closing angles before it balance, as TypeScript
// matches type arguments: over tokens a type is written with, brackets balanced.
function balancedOpening(template: Node): Node | null {
  let after = tokenBefore(template)
  let angles = after === null ? 0 : (CLOSING_ANGLES.get(after.type) ?? 0)
  if (after === null || angles === 0) return null
  const brackets: string[] = []
  for (let token = tokenBefore(after); token !== null; after = token, token = tokenBefore(token)) {
    if (after.type === "(" && ENDS_AN_OPERAND.has(token.type)) return null
    const closing = CLOSING_ANGLES.get(token.type)
    if (closing !== undefined) angles += closing
    else if (token.type === "<") {
      angles -= 1
      if (angles === 0) return brackets.length === 0 ? token : null
    } else if (CLOSING_BRACKETS.has(token.type)) brackets.push(token.type)
    else if (BRACKETS.has(token.type)) {
      if (brackets.pop() !== BRACKETS.get(token.type)) return null
    } else if (!writtenInAType(token, after, brackets.length > 0)) return null
  }
  return null
}

// A call's parentheses follow an operand; a type's follow an operator, a `<` or a `,`.
const ENDS_AN_OPERAND: ReadonlySet<string> = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "predefined_type",
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "number",
  "string",
  "template_string",
  ")",
  "]",
])

const TYPE_WORDS: ReadonlySet<string> = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "predefined_type",
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "string",
  "template_string",
  "template_literal_type",
  "number",
  ".",
  ",",
  "|",
  "&",
  "=>",
  "...",
  "typeof",
  "keyof",
  "readonly",
  "unique",
  "infer",
  "extends",
  "is",
  "asserts",
  "new",
  "abstract",
  "void",
  "in",
  "as",
])

// Written only inside an object type, a tuple or a parameter list.
const NESTED_TYPE_WORDS: ReadonlySet<string> = new Set([":", ";", "?"])

function writtenInAType(token: Node, after: Node, nested: boolean): boolean {
  if (TYPE_WORDS.has(token.type)) return true
  if (NESTED_TYPE_WORDS.has(token.type)) return nested
  return token.type === "-" && after.type === "number"
}

// A tag is a left-hand-side expression: an operator before it binds the call to its right.
const TAG_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "this",
  "super",
  "member_expression",
  "subscript_expression",
  "call_expression",
  "parenthesized_expression",
  "non_null_expression",
])

// Tokens that end a tag without being one, read up to the expression they end.
const TAG_ENDINGS: ReadonlySet<string> = new Set([
  "property_identifier",
  "private_property_identifier",
  "arguments",
])

function tagBefore(opening: Node): Node | null {
  const last = tokenBefore(opening)
  if (last === null) return null
  let tag = TAG_TYPES.has(last.type) ? last : null
  for (
    let node = last.parent;
    node !== null && node.endIndex === last.endIndex;
    node = node.parent
  ) {
    if (TAG_TYPES.has(node.type)) tag = node
    else if (!TAG_ENDINGS.has(node.type)) break
  }
  return tag
}

// Strings, numbers and comments are tokens to this reading, whatever the grammar holds inside them.
const ATOMS: ReadonlySet<string> = new Set([
  "string",
  "template_string",
  "template_literal_type",
  "number",
  "regex",
  "predefined_type",
  "comment",
])

// The written token before `node`, past comments and the tokens the grammar inserted.
function tokenBefore(node: Node): Node | null {
  for (let token = previousToken(node); token !== null; token = previousToken(token)) {
    if (token.type !== "comment" && token.endIndex > token.startIndex) return token
  }
  return null
}

function previousToken(node: Node): Node | null {
  for (let at: Node | null = node; at !== null; at = at.parent) {
    const previous = at.previousSibling
    if (previous !== null) return lastToken(previous)
  }
  return null
}

function lastToken(node: Node): Node {
  let token = node
  while (!ATOMS.has(token.type) && token.childCount > 0) {
    const last = token.child(token.childCount - 1)
    if (last === null) break
    token = last
  }
  return token
}

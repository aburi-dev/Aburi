import { unwrapValue } from "@aburi/core"
import type { MergedDeclaration, SymbolCandidate } from "@aburi/types"
import type { Language, Node, TreeCursor } from "web-tree-sitter"
import { firstNonCommentChild, hasLeadingOperator, leadingOperatorOperand } from "./ast-helpers"

export function normalizeAst(symbol: SymbolCandidate<Node>): string {
  if (symbol.kind === "call") return serialize(symbol.fullNode)
  const described: { node: Node; fullNode: Node }[] = []
  for (const declaration of [symbol, ...(symbol.mergedDeclarations ?? [])]) {
    const node = describedNode(declaration)
    if (described.some((seen) => seen.node.id === node.id)) continue
    described.push({ node, fullNode: declaration.fullNode })
  }
  return described
    .flatMap(({ node, fullNode }) => [
      serialize(node),
      classHead(fullNode),
      // A declaration described whole already carries its list and its modifiers.
      node.id === fullNode.id ? "" : parameterList(fullNode),
      node.id === fullNode.id ? "" : memberHead(fullNode),
    ])
    .filter((part) => part.length > 0)
    .join(" ")
}

// The api axis hashes a parameter's type and form, not its name, its pattern or its default's value,
// so a function described by its body alone saw none of those edits.
function parameterList(fullNode: Node): string {
  const list = fullNode.childForFieldName("parameters")
  if (list !== null) return firstNonCommentChild(list) === null ? "" : serialize(list)
  const lone = fullNode.childForFieldName("parameter")
  return lone === null ? "" : wrapLoneParameter(serialize(lone))
}

// A formatter adds the parentheses a lone arrow parameter may go without (`x => …` → `(x) => …`),
// so it is described as the parenthesised spelling parses.
function wrapLoneParameter(parameter: string): string {
  return `(formal_parameters (required_parameter ${parameter}))`
}

// The modifiers neither the member's id nor another axis reads: `static` is in the id, an
// accessibility modifier is its `visibility`, and `async` and `*` are on its signature.
const MEMBER_HEAD_MODIFIERS: ReadonlySet<string> = new Set([
  "get",
  "set",
  "override_modifier",
  "?",
  "readonly",
  "accessor",
])

function memberHead(fullNode: Node): string {
  const member = fullNode.type === "method_definition" ? fullNode : fieldHolding(fullNode)
  if (member === null) return ""
  const parts: string[] = []
  for (const child of member.children) {
    if (child === null || !MEMBER_HEAD_MODIFIERS.has(child.type)) continue
    parts.push(child.isNamed ? serialize(child) : JSON.stringify(child.type))
  }
  return parts.join(" ")
}

function fieldHolding(fn: Node): Node | null {
  for (let node = fn.parent; node !== null; node = node.parent) {
    if (node.type === "public_field_definition") {
      const value = node.childForFieldName("value")
      return value !== null && unwrapValue(value).id === fn.id ? node : null
    }
    if (FIELD_BOUNDARIES.has(node.type)) return null
  }
  return null
}

const FIELD_BOUNDARIES: ReadonlySet<string> = new Set(["class_body", "statement_block", "program"])

function classHead(fullNode: Node): string {
  if (!CLASS_TYPES.has(fullNode.type)) return ""
  const parts: string[] = []
  if (fullNode.type === "abstract_class_declaration") parts.push(JSON.stringify("abstract"))
  for (const child of fullNode.namedChildren) {
    if (child === null) continue
    if (child.type === "type_parameters" || child.type === "class_heritage") {
      parts.push(serialize(child))
    }
  }
  return parts.join(" ")
}

const CLASS_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "class",
])

function describedNode(declaration: Pick<MergedDeclaration<Node>, "bodyNode" | "fullNode">): Node {
  const { bodyNode, fullNode } = declaration
  return bodyNode !== null && bodyNode.parent?.id === fullNode.id ? bodyNode : fullNode
}

function serialize(node: Node): string {
  if (node.isExtra) return ""
  const cursor = node.walk()
  try {
    return serializeAt(cursor, node.type, grammarOf(node.tree.language))
  } finally {
    cursor.delete()
  }
}

// A cursor reads a child's type and flags without allocating a `Node` for it, which `children` does
// for every anonymous token. The cursor has no `isExtra`, so only the types that can be extras are
// materialised to ask.
function serializeAt(cursor: TreeCursor, type: string, grammar: Grammar): string {
  if (SKIPPED_NODE_TYPES.has(type)) return ""
  if (hasLeadingOperator(type)) {
    const operand = leadingOperatorOperand(cursor.currentNode)
    if (operand !== null) return serialize(operand)
  }

  const children: string[] = []
  if (cursor.gotoFirstChild()) {
    let previousType: string | null = null
    const parameterField = type === "arrow_function" ? grammar.parameterField : null
    do {
      if (cursor.nodeIsMissing) continue
      const typeId = cursor.nodeTypeId
      const childType = grammar.typeName(typeId)
      if (grammar.mayBeExtra.has(childType) && cursor.currentNode.isExtra) continue
      if (grammar.isNamed(typeId)) {
        const lone = parameterField !== null && cursor.currentFieldId === parameterField
        const rendered = serializeAt(cursor, childType, grammar)
        if (lone) children.push(wrapLoneParameter(rendered))
        else if (rendered.length > 0) children.push(rendered)
      } else if (
        childType === "," &&
        ELIDING_TYPES.has(type) &&
        (previousType === "[" || previousType === ",")
      ) {
        children.push(JSON.stringify(childType))
      } else if (!FORMATTING_TOKENS.has(childType)) {
        children.push(JSON.stringify(childType))
      }
      previousType = childType
    } while (cursor.gotoNextSibling())
    cursor.gotoParent()
  }

  const leafText = LEAF_TEXT_TYPES.has(type) ? leafPayload(cursor.nodeText) : null
  if (children.length === 0 && leafText === null) return `(${type})`
  if (children.length === 0 && leafText !== null) return `(${type} ${leafText})`
  return `(${type} ${children.join(" ")})`
}

interface Grammar {
  typeName(typeId: number): string
  isNamed(typeId: number): boolean
  readonly parameterField: number | null
  readonly mayBeExtra: ReadonlySet<string>
}

const grammars = new WeakMap<Language, Grammar>()

function grammarOf(language: Language): Grammar {
  const known = grammars.get(language)
  if (known !== undefined) return known
  const named: boolean[] = []
  const grammar: Grammar = {
    // Falls back as `Node.type` does: the grammar has no name for the `ERROR` id.
    typeName: (typeId) => language.types[typeId] || "ERROR",
    isNamed: (typeId) => (named[typeId] ??= language.nodeTypeIsNamed(typeId)),
    parameterField: language.fieldIdForName("parameter"),
    mayBeExtra: extraTypes(language),
  }
  grammars.set(language, grammar)
  return grammar
}

// An extra may appear in any state and is shifted without leaving it, so the start state's table
// names each one. Error recovery also inserts `ERROR` nodes as extras.
function extraTypes(language: Language): ReadonlySet<string> {
  const types = new Set(["ERROR"])
  for (let typeId = 0; typeId < language.nodeTypeCount; typeId++) {
    const name = language.types[typeId]
    if (name && language.nextState(START_STATE, typeId) === START_STATE) types.add(name)
  }
  return types
}

const START_STATE = 1

const ELIDING_TYPES: ReadonlySet<string> = new Set(["array", "array_pattern"])

const FORMATTING_TOKENS: ReadonlySet<string> = new Set([
  ";",
  ",",
  '"',
  "'",
  "`",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
])

const SKIPPED_NODE_TYPES: ReadonlySet<string> = new Set(["comment", "hash_bang_line"])

const LEAF_TEXT_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "property_identifier",
  "type_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "private_property_identifier",
  "number",
  "string_fragment",
  "regex_pattern",
  "regex_flags",
  "escape_sequence",
  "template_chars",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "super",
])

function leafPayload(text: string): string | null {
  if (text.length === 0) return null
  return JSON.stringify(text)
}

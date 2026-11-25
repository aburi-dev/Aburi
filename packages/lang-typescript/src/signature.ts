import { compareCodeUnit } from "@aburi/core"
import type { Signature } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import {
  findChild,
  firstNonCommentChild,
  leadingOperatorOperand,
  type ThrownValue,
  thrownValue,
  walkDescendants,
} from "./ast-helpers"
import { decoratorNodes } from "./decorators"
import { bindingOf } from "./name-binding"
import { collectPatternBindings, isRepairedPattern } from "./pattern-bindings"

export function buildSignature(declaration: Node, jsDocText: string | null): Signature {
  const async = detectAsync(declaration)
  const generator = detectGenerator(declaration)
  const typeParameters = readTypeParameters(declaration)
  const inputs = readParameters(declaration)
  const outputs = readReturnType(declaration)
  const throws = readThrows(declaration, jsDocText)
  return { async, generator, inputs, outputs, throws, typeParameters }
}

function detectAsync(node: Node): boolean {
  for (const child of node.children) {
    if (child !== null && child.type === "async") return true
  }
  return false
}

function detectGenerator(node: Node): boolean {
  for (const child of node.children) {
    if (child !== null && (child.type === "*" || child.type === "generator")) return true
  }
  return false
}

function readTypeParameters(node: Node): string[] {
  const params = node.childForFieldName("type_parameters") ?? findChild(node, "type_parameters")
  if (params === null) return []
  const out: string[] = []
  for (const child of params.namedChildren) {
    if (child === null || child.type !== "type_parameter") continue
    out.push(typeText(child))
  }
  return out
}

function readParameters(node: Node): Signature["inputs"] {
  const params = node.childForFieldName("parameters") ?? findChild(node, "formal_parameters")
  if (params === null) return readBareParameter(node)
  const out: Signature["inputs"] = []
  for (const child of params.namedChildren) {
    if (child === null) continue
    if (child.type === "required_parameter" || child.type === "optional_parameter") {
      out.push(readParameter(child))
    }
  }
  return out
}

function readBareParameter(node: Node): Signature["inputs"] {
  const parameter = node.childForFieldName("parameter")
  if (parameter === null) return []
  const name = parameter.text.trim()
  if (name.length === 0) return []
  return [{ name, type: "" }]
}

function readParameter(param: Node): Signature["inputs"][number] {
  const pattern = param.childForFieldName("pattern") ?? param.namedChild(0)
  const rest = pattern !== null && pattern.type === "rest_pattern"
  const binding = rest ? pattern.namedChild(0) : pattern
  const input: Signature["inputs"][number] = {
    name: writtenText(binding) ?? writtenText(pattern) ?? param.text,
    type: extractParamType(param),
  }
  if (param.type === "optional_parameter" || param.childForFieldName("value") !== null) {
    input.optional = true
  }
  if (rest) input.rest = true
  const bindings = readPatternBindings(binding)
  if (bindings.length > 0) input.bindings = bindings
  const modifiers = readParameterModifiers(param)
  if (modifiers.length > 0) input.modifiers = modifiers
  const decorators = decoratorNodes(param).flatMap(decoratorText)
  if (decorators.length > 0) input.decorators = decorators
  return input
}

type ParameterModifier = NonNullable<Signature["inputs"][number]["modifiers"]>[number]

function readParameterModifiers(param: Node): ParameterModifier[] {
  const out: ParameterModifier[] = []
  for (const child of param.children) {
    if (child === null) continue
    if (child.type === "accessibility_modifier") {
      if (isAccessibilityModifier(child.text)) out.push(child.text)
    } else if (child.type === "override_modifier") out.push("override")
    else if (child.type === "readonly") out.push("readonly")
  }
  return out
}

const ACCESSIBILITY_MODIFIERS: ReadonlySet<string> = new Set<ParameterModifier>([
  "public",
  "private",
  "protected",
])

function isAccessibilityModifier(text: string): text is ParameterModifier {
  return ACCESSIBILITY_MODIFIERS.has(text)
}

// A formatter breaks a decorator's arguments over lines and adds a trailing comma, as it does a
// type's, so a parameter's decorator is recorded as it reads on one line, after its `@`.
function decoratorText(decorator: Node): string[] {
  const written = firstNonCommentChild(decorator)
  return written === null ? [] : [oneLine(lineTokens(written, []), EXPRESSION_BRACKETS)]
}

function writtenText(node: Node | null): string | null {
  if (node === null || node.isMissing || node.type === "ERROR") return null
  return node.text
}

function readPatternBindings(binding: Node | null): string[] {
  if (binding === null) return []
  const destructures =
    binding.type === "object_pattern" ||
    binding.type === "array_pattern" ||
    isRepairedPattern(binding)
  if (!destructures) return []
  const out: string[] = []
  for (const node of collectPatternBindings(binding, "skip")) {
    const name = writtenText(node)
    if (name !== null) out.push(name)
  }
  return out
}

function extractParamType(param: Node): string {
  const typeAnn = param.childForFieldName("type") ?? findChild(param, "type_annotation")
  if (typeAnn === null) return ""
  const inner = firstNonCommentChild(typeAnn)
  return inner !== null ? typeText(inner) : typeAnn.text.replace(/^:\s*/, "").trim()
}

function readReturnType(node: Node): string[] {
  const returnType = node.childForFieldName("return_type") ?? findChild(node, "type_annotation")
  if (returnType === null) return []
  const inner = firstNonCommentChild(returnType)
  const text = inner !== null ? typeText(inner) : returnType.text.replace(/^:\s*/, "").trim()
  return text.length > 0 ? [text] : []
}

const VERBATIM_TYPES: ReadonlySet<string> = new Set([
  "string",
  "template_literal_type",
  "template_string",
])

interface Brackets {
  readonly opening: ReadonlySet<string>
  readonly closing: ReadonlySet<string>
}

const TYPE_BRACKETS: Brackets = {
  opening: new Set(["<", "(", "["]),
  closing: new Set([">", ")", "]"]),
}

// In an expression `<` and `>` compare, and an object literal's braces are spaced on one line by
// some formatters and not by others.
const EXPRESSION_BRACKETS: Brackets = {
  opening: new Set(["(", "[", "{"]),
  closing: new Set([")", "]", "}"]),
}

const SEPARATORS: ReadonlySet<string> = new Set([",", ";"])

interface TypeToken {
  readonly text: string
  readonly start: number
  readonly end: number
}

// A formatter that breaks a type over lines adds the layout, a trailing separator and a union's
// leading `|`, and drops them when it joins the type again, so a type is recorded as it reads on
// one line. On one line it separates an object type's members with `;`, and over lines with none.
function typeText(type: Node): string {
  return oneLine(lineTokens(type, []), TYPE_BRACKETS)
}

function oneLine(tokens: readonly TypeToken[], brackets: Brackets): string {
  let out = ""
  let previous: TypeToken | null = null
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1]
    if (SEPARATORS.has(token.text) && next !== undefined && brackets.closing.has(next.text))
      continue
    const spaced =
      previous !== null &&
      previous.end < token.start &&
      !brackets.opening.has(previous.text) &&
      !brackets.closing.has(token.text) &&
      !SEPARATORS.has(token.text)
    out += spaced ? ` ${token.text}` : token.text
    previous = token
  }
  return out
}

function lineTokens(node: Node, out: TypeToken[]): TypeToken[] {
  if (node.isMissing || node.isExtra) return out
  if (node.childCount === 0 || VERBATIM_TYPES.has(node.type)) {
    out.push({ text: node.text, start: node.startIndex, end: node.endIndex })
    return out
  }
  if (node.type === "object_type") return objectTypeTokens(node, out)
  const operand = leadingOperatorOperand(node)
  if (operand !== null) return lineTokens(operand, out)
  for (const child of node.children) lineTokens(child, out)
  return out
}

function objectTypeTokens(node: Node, out: TypeToken[]): TypeToken[] {
  let previousMember: Node | null = null
  for (const child of node.children) {
    if (child.isNamed && !child.isExtra && !child.isMissing) {
      if (previousMember !== null) {
        const at = previousMember.endIndex
        out.push({ text: ";", start: at, end: at })
      }
      previousMember = child
    } else if (SEPARATORS.has(child.type)) {
      continue
    }
    lineTokens(child, out)
  }
  return out
}

function readThrows(node: Node, jsDocText: string | null): string[] {
  const seen = new Set<string>()
  const body = node.childForFieldName("body")
  if (body !== null) {
    for (const descendant of walkDescendants(body)) {
      if (descendant.type !== "throw_statement") continue
      const thrown = extractThrownType(descendant, node)
      if (thrown !== null) seen.add(thrown)
    }
  }
  if (jsDocText !== null) {
    for (const tag of extractJsDocThrows(jsDocText)) seen.add(tag)
  }
  return [...seen].sort(compareCodeUnit)
}

// A name the Symbol binds itself (a parameter, a `catch` clause, a local) says nothing a caller can
// rely on, and renaming one is no api change.
function extractThrownType(throwNode: Node, declaration: Node): string | null {
  const thrown = thrownValue(throwNode)
  const named = thrown === null ? null : thrownName(thrown)
  const head = named === null ? null : leadingName(named)
  if (named === null || head === null) return null
  if (head.type !== "identifier") return named.text
  const binding = bindingOf(head, head.text)
  return binding === null || !isWithin(binding.scope, declaration) ? named.text : null
}

function thrownName({ node, viaNew }: ThrownValue): Node | null {
  if (viaNew || node.type === "identifier") return node
  return node.type === "call_expression" ? node.childForFieldName("function") : null
}

// `this` and `super` read the class, which the Symbol does not bind. A chain that starts from no
// name, from a literal or `(a || b)`, names nothing a caller could look up.
function leadingName(name: Node): Node | null {
  let head: Node | null = name
  while (head !== null && !CHAIN_STARTS.has(head.type)) head = chainHead(head)
  return head
}

const CHAIN_STARTS: ReadonlySet<string> = new Set(["identifier", "this", "super"])

function chainHead(link: Node): Node | null {
  switch (link.type) {
    case "member_expression":
    case "subscript_expression":
      return link.childForFieldName("object")
    case "call_expression":
      return link.childForFieldName("function")
    case "new_expression":
      return link.childForFieldName("constructor")
    case "non_null_expression":
    case "parenthesized_expression":
      return firstNonCommentChild(link)
    default:
      return null
  }
}

function isWithin(node: Node, ancestor: Node): boolean {
  for (let cursor: Node | null = node; cursor !== null; cursor = cursor.parent) {
    if (cursor.id === ancestor.id) return true
  }
  return false
}

const JSDOC_THROWS_PATTERN =
  /@(?:throws?|exception)(?![\w$])[ \t]*(?:\{([^}\n]+)\})?((?:\*+(?![*/])|(?!\n[ \t]*(?:\*[ \t]*)?@|[ \t]@[a-zA-Z])[^*])*)/g

const INLINE_LINK_PATTERN = /^@link(?:code|plain)?\s+([^\s|]+)/

const DECLARATION_PATH_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

const BARE_TYPE_PATTERN = /^[A-Z][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/

function extractJsDocThrows(jsDoc: string): string[] {
  const out: string[] = []
  for (const match of jsDoc.matchAll(JSDOC_THROWS_PATTERN)) {
    const braced = match[1]?.trim()
    if (braced !== undefined) {
      const typed = braced.startsWith("@") ? linkTarget(braced) : braced
      if (typed !== null && typed.length > 0) out.push(typed)
      continue
    }
    const text = tagText(match[2] ?? "")
    if (BARE_TYPE_PATTERN.test(text)) out.push(text)
  }
  return out
}

function linkTarget(inline: string): string | null {
  const target = INLINE_LINK_PATTERN.exec(inline)?.[1]
  return target !== undefined && DECLARATION_PATH_PATTERN.test(target) ? target : null
}

function tagText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\*/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

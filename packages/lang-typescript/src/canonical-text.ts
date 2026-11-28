import type { Node } from "web-tree-sitter"
import { leadingOperatorOperand } from "./ast-helpers"
import { clarifiedOperand, redundantlyParenthesized } from "./parentheses"
import {
  canonicalJsxAttributeString,
  canonicalNumber,
  canonicalString,
  holdsKeys,
  isBareNew,
  isKeyPosition,
  JsxTextRun,
  unquotedKey,
} from "./spelling"
import { inSplitTypeArguments } from "./typed-tag"

/**
 * The text a rule, a type or a decorator records: rebuilt from its tokens on one line, with the
 * spacing between them regenerated rather than copied, so the spellings a formatter chooses between
 * — the quotes and escapes of a string, quotes around a key that needs none, a trailing comma,
 * parentheses the grouping does not need or an arrow's lone parameter takes either way, optional
 * semicolons, `new` without an argument list, a number's zeros and case, line breaks and comments —
 * read alike. Reading stops once `enough` UTF-16 units of non-space text are written.
 */
export function canonicalText(
  node: Node,
  from: number = node.startIndex,
  to: number = node.endIndex,
  enough: number = UNBOUNDED,
): string {
  const tokens: Token[] = []
  collect(node, { from, to, parked: true, budget: { left: enough } }, tokens, EDGE)
  return join(tokens)
}

const UNBOUNDED = Number.POSITIVE_INFINITY

/**
 * `canonicalText` of the tokens the grammar placed, without what recovery parked beside them: a
 * signature reads its types and its parameters' decorators so, and the syntax axis takes what was
 * parked in a head.
 */
export function canonicalPlacedText(node: Node): string {
  const tokens: Token[] = []
  const range = {
    from: node.startIndex,
    to: node.endIndex,
    parked: false,
    budget: { left: UNBOUNDED },
  }
  collect(node, range, tokens, EDGE)
  return join(tokens)
}

interface Token extends Place {
  readonly text: string
  readonly type: string
  readonly start: number
  readonly end: number
}

interface Range {
  readonly from: number
  readonly to: number
  /** Whether an extra the grammar repaired, parked beside the tokens it could place, is read. */
  readonly parked: boolean
  readonly budget: { left: number }
}

interface Place {
  readonly parent: string
  readonly first: boolean
  readonly last: boolean
  /** Inside a node the grammar repaired, where a token's role is not the one its type names. */
  readonly repaired: boolean
}

const EDGE: Place = { parent: "", first: true, last: true, repaired: false }

function collect(node: Node, range: Range, out: Token[], place: Place): void {
  if (range.budget.left <= 0 || node.isMissing || node.type === "comment") return
  if (node.endIndex <= range.from || node.startIndex >= range.to) return
  const whole = within(node, range)
  if (whole) {
    const verbatim = verbatimText(node, place.parent, range.budget.left)
    if (verbatim !== null) {
      const token = tokenOf(node, verbatim, place)
      // A quoted key is a name, and is spaced as one: `"m"(a) {}`, as `m(a) {}`.
      const key = holdsKeys(place.parent) && isKeyPosition(node)
      emit(key ? { ...token, type: "property_identifier" } : token, range, out)
      return
    }
  }
  if (node.childCount === 0) {
    if (whole && !isStatementTerminator(node)) emit(leafToken(node, place), range, out)
    return
  }
  const operand =
    leadingOperatorOperand(node) ??
    (node.parent !== null && isSplitByTypeArguments(node.parent)
      ? null
      : redundantlyParenthesized(node))
  if (operand !== null) {
    collect(operand, range, out, place)
    return
  }
  collectChildren(node, range, out, place.repaired || node.type === ERROR_TYPE)
}

function emit(token: Token, range: Range, out: Token[]): void {
  out.push(token)
  if (range.budget.left !== UNBOUNDED) range.budget.left -= nonSpaceLength(token.text)
}

function nonSpaceLength(text: string): number {
  return text.replace(/\s+/g, "").length
}

function tokenOf(node: Node, text: string, place: Place): Token {
  return {
    text,
    type: node.type,
    start: node.startIndex,
    end: node.endIndex,
    ...place,
    repaired: place.repaired || node.type === ERROR_TYPE,
  }
}

const ERROR_TYPE = "ERROR"

// A typed tag the grammar read as operators is spelled as the list of type arguments it is.
function leafToken(node: Node, place: Place): Token {
  const token = tokenOf(node, node.text, place)
  if (!ANGLE_OPERATORS.has(node.type) || place.parent !== "binary_expression") return token
  if (!inSplitTypeArguments(node)) return token
  return { ...token, type: node.type === "<" ? "<" : ">", parent: "type_arguments" }
}

const ANGLE_OPERATORS: ReadonlySet<string> = new Set(["<", ">", ">>", ">>>"])

// The grouping the grammar gives a typed tag it read as operators is not the program's, so it
// neither needs parentheses nor makes the written ones redundant.
function isSplitByTypeArguments(node: Node): boolean {
  if (node.type !== "binary_expression" && node.type !== "sequence_expression") return false
  const operator =
    node.type === "binary_expression"
      ? node.childForFieldName("operator")
      : (node.children.find((child) => child.type === ",") ?? null)
  return operator !== null && inSplitTypeArguments(operator)
}

function collectChildren(node: Node, range: Range, out: Token[], repaired: boolean): void {
  const children = node.children.filter(
    (child) => !child.isMissing && child.type !== "comment" && (range.parked || !child.isExtra),
  )
  const statements = STATEMENT_CONTAINERS.has(node.type) ? statementIds(node, children) : null
  const members = MEMBER_CONTAINERS.has(node.type)
  let previousMember = false
  for (const [index, child] of children.entries()) {
    const place: Place = {
      parent: node.type,
      first: index === 0,
      last: index === children.length - 1,
      repaired,
    }
    if (statements !== null) {
      if (child.type === "empty_statement") continue
      if (statements.has(child.id)) {
        if (previousMember) out.push(synthetic(";", node.type, child.startIndex))
        previousMember = true
      }
    } else if (members) {
      if (SEPARATORS.has(child.type)) continue
      if (child.isNamed) {
        if (previousMember) out.push(synthetic(";", node.type, child.startIndex))
        previousMember = true
      }
    }
    if (isLoneArrowParameter(node, child)) {
      parenthesize(child, "formal_parameters", range, out, place)
      continue
    }
    const clarified =
      within(child, range) && !isSplitByTypeArguments(node) && !isSplitByTypeArguments(child)
        ? clarifiedOperand(node, child)
        : null
    if (clarified !== null) {
      parenthesize(clarified, "parenthesized_expression", range, out, place)
      continue
    }
    collect(child, range, out, place)
  }
  if (!repaired && isBareNew(node) && within(node, range)) {
    out.push(synthetic("(", "arguments", node.endIndex))
    out.push(synthetic(")", "arguments", node.endIndex))
  }
}

function parenthesize(node: Node, parent: string, range: Range, out: Token[], place: Place): void {
  out.push({ ...synthetic("(", parent, node.startIndex), first: true })
  collect(node, range, out, { ...place, parent, first: false })
  out.push({ ...synthetic(")", parent, node.endIndex), last: true })
}

function within(node: Node, range: Range): boolean {
  return node.startIndex >= range.from && node.endIndex <= range.to
}

function synthetic(text: string, parent: string, at: number): Token {
  return {
    text,
    type: text,
    parent,
    first: false,
    last: false,
    repaired: false,
    start: at,
    end: at,
  }
}

// Automatic semicolon insertion makes the `;` that ends a statement a formatter's choice, so the
// statements of a block, a program or a `case` are joined by one whatever the source writes, and
// the members of a class or an object type the same way.
const STATEMENT_CONTAINERS: ReadonlySet<string> = new Set([
  "statement_block",
  "program",
  "switch_case",
  "switch_default",
])

const MEMBER_CONTAINERS: ReadonlySet<string> = new Set(["class_body", "object_type"])

function statementIds(container: Node, children: readonly Node[]): ReadonlySet<number> {
  const label = container.childForFieldName("value")
  const ids = new Set<number>()
  for (const child of children) {
    if (!child.isNamed || child.type === "empty_statement") continue
    if (label !== null && child.id === label.id) continue
    ids.add(child.id)
  }
  return ids
}

// An empty statement is nothing but its `;`, and the declaration a `for` starts with ends at its own.
function isStatementTerminator(token: Node): boolean {
  if (token.type !== ";") return false
  const statement = token.parent
  if (statement === null || statement.lastChild?.id !== token.id) return false
  if (!STATEMENT_TYPE.test(statement.type) || statement.type === "empty_statement") return false
  const loop = statement.parent
  return (
    loop?.type !== "for_statement" || loop.childForFieldName("initializer")?.id !== statement.id
  )
}

const STATEMENT_TYPE = /_(?:statement|declaration|signature)$|^import_alias$/

function isLoneArrowParameter(parent: Node, child: Node): boolean {
  if (parent.type !== "arrow_function") return false
  const parameter = parent.childForFieldName("parameter")
  return parameter !== null && parameter.id === child.id
}

const SEPARATORS: ReadonlySet<string> = new Set([",", ";"])

function verbatimText(node: Node, parent: string, enough: number): string | null {
  switch (node.type) {
    case "string":
      return (holdsKeys(parent) ? unquotedKey(node) : null) ?? canonicalString(node)
    case "number":
      return canonicalNumber(node.text)
    case "template_string":
    case "template_literal_type":
      return templateText(node)
    case "regex":
      return node.text
    case "jsx_element":
    case "jsx_self_closing_element":
      return jsxText(node, enough)
    default:
      return null
  }
}

// A template's text is content, character for character; only what `${}` holds is code.
function templateText(node: Node): string {
  let out = ""
  let at = node.startIndex
  for (const child of node.children) {
    if (child === null) continue
    out += node.text.slice(at - node.startIndex, child.startIndex - node.startIndex)
    if (child.type === "template_substitution" || child.type === "template_type") {
      const held = named(child)
      out += `\${${held.map((part) => canonicalText(part)).join(" ")}}`
    } else {
      out += child.text
    }
    at = child.endIndex
  }
  return out + node.text.slice(at - node.startIndex)
}

function join(tokens: readonly Token[]): string {
  let out = ""
  let previous: Token | null = null
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1]
    if (next !== undefined && isDroppedBefore(tokens[index - 1], token, next)) continue
    if (previous !== null && spaced(previous, token)) out += " "
    out += token.text
    previous = token
  }
  return out
}

// A trailing separator before a closing bracket is a formatter's choice, not the code's; a comma
// right after `[` or another comma is an array hole, which the program counts.
function isDroppedBefore(before: Token | undefined, token: Token, next: Token): boolean {
  if (token.type === ",") return isClosing(next) && before?.type !== "[" && before?.type !== ","
  if (token.type === ";") return next.type === "}"
  return false
}

function isClosing(token: Token): boolean {
  return CLOSING.has(token.type) || (token.type === ">" && isTypeAngle(token))
}

const CLOSING: ReadonlySet<string> = new Set([")", "]", "}"])

const GLUED_AFTER: ReadonlySet<string> = new Set(["(", "[", ".", "?.", "...", "@"])

const GLUED_BEFORE: ReadonlySet<string> = new Set([",", ";", ")", "]", ".", "?."])

const PREFIX_OPERATORS: ReadonlySet<string> = new Set(["!", "-", "+", "~", "++", "--"])

const POSTFIX_OPERATORS: ReadonlySet<string> = new Set(["++", "--"])

// A `?` or `:` is spaced on both sides only where it separates the branches of a conditional.
const CONDITIONAL_PARENTS: ReadonlySet<string> = new Set(["ternary_expression", "conditional_type"])

const LIST_PARENTS: ReadonlySet<string> = new Set(["arguments", "formal_parameters"])

const INDEXING_PARENTS: ReadonlySet<string> = new Set([
  "subscript_expression",
  "array_type",
  "lookup_type",
])

const GENERATOR_PARENTS: ReadonlySet<string> = new Set([
  "generator_function_declaration",
  "generator_function",
  "yield_expression",
])

const NAME_ENDS: ReadonlySet<string> = new Set([
  "identifier",
  "property_identifier",
  "private_property_identifier",
  "type_identifier",
  "shorthand_property_identifier",
  "this",
  "super",
  "import",
  ")",
  "]",
])

function spaced(previous: Token, token: Token): boolean {
  // A repaired token's role is unknown, so the source's own spacing is kept around it.
  if (previous.repaired || token.repaired) return previous.end < token.start
  if (GLUED_AFTER.has(previous.type) || GLUED_BEFORE.has(token.type)) return false
  if (previous.type === "{" && token.type === "}") return false
  if (isPrefixOperator(previous)) return mergesWith(previous, token)
  if (isPostfixOperator(token)) return false
  if (previous.type === "<" && isTypeAngle(previous)) return false
  if (token.type === ">" && isTypeAngle(token)) return false
  if (token.type === "<" && isTypeAngle(token)) return !endsName(previous)
  if (token.type === ":" || token.type === "?") return CONDITIONAL_PARENTS.has(token.parent)
  if (token.type === "!" && token.parent === "non_null_expression") return false
  if (token.type === "(" && LIST_PARENTS.has(token.parent)) return !endsName(previous)
  if (token.type === "[" && INDEXING_PARENTS.has(token.parent)) return false
  if (token.type === "*" && GENERATOR_PARENTS.has(token.parent)) return false
  if (previous.type === "*" && previous.parent === "method_definition") return false
  return true
}

function endsName(token: Token): boolean {
  if (NAME_ENDS.has(token.type)) return true
  if (token.type === ">") return isTypeAngle(token)
  if (token.type === "?") return !CONDITIONAL_PARENTS.has(token.parent)
  return false
}

function isPrefixOperator(token: Token): boolean {
  return (
    token.first &&
    PREFIX_OPERATORS.has(token.type) &&
    (token.parent === "unary_expression" || token.parent === "update_expression")
  )
}

// `- -a` negates twice where `--a` decrements, so a sign keeps its space before another of its kind.
function mergesWith(sign: Token, token: Token): boolean {
  return (sign.type === "-" || sign.type === "+") && token.text.startsWith(sign.type)
}

function isPostfixOperator(token: Token): boolean {
  return !token.first && POSTFIX_OPERATORS.has(token.type) && token.parent === "update_expression"
}

function isTypeAngle(token: Token): boolean {
  return token.parent === "type_arguments" || token.parent === "type_parameters"
}

// JSX is rebuilt by its own rule: the space between two children is content, so none is added,
// and the text between tags reads as React renders it.
function jsxText(node: Node, enough: number): string {
  if (node.type === "jsx_self_closing_element") return `<${jsxTag(node)} />`
  let out = ""
  let written = 0
  const text = new JsxTextRun()
  const write = (piece: string) => {
    out += piece
    if (enough !== UNBOUNDED) written += nonSpaceLength(piece)
  }
  for (const child of named(node)) {
    if (written >= enough) break
    if (text.takes(child)) continue
    write(text.flush())
    write(jsxChild(child, enough - written))
  }
  write(text.flush())
  return out
}

function jsxChild(child: Node, enough: number): string {
  switch (child.type) {
    case "jsx_opening_element":
      return `<${jsxTag(child)}>`
    case "jsx_closing_element": {
      const name = child.childForFieldName("name")
      return `</${name === null ? "" : jsxName(name)}>`
    }
    case "jsx_expression":
      return jsxExpression(child, enough)
    case "jsx_element":
    case "jsx_self_closing_element":
      return jsxText(child, enough)
    default:
      return canonicalText(child, child.startIndex, child.endIndex, enough)
  }
}

function jsxTag(element: Node): string {
  const parts: string[] = []
  for (const child of named(element)) {
    if (child.type === "type_arguments") {
      parts[parts.length - 1] = `${parts.at(-1) ?? ""}${canonicalText(child)}`
    } else if (child.type === "jsx_attribute") {
      parts.push(jsxAttribute(child))
    } else if (child.type === "jsx_expression") {
      parts.push(jsxExpression(child, UNBOUNDED))
    } else {
      parts.push(jsxName(child))
    }
  }
  return parts.join(" ")
}

function jsxAttribute(attribute: Node): string {
  const [name, value] = named(attribute)
  if (name === undefined) return ""
  if (value === undefined) return jsxName(name)
  const written =
    value.type === "string"
      ? canonicalJsxAttributeString(value.text)
      : value.type === "jsx_expression"
        ? jsxExpression(value, UNBOUNDED)
        : jsxText(value, UNBOUNDED)
  return `${jsxName(name)}=${written}`
}

function jsxExpression(expression: Node, enough: number): string {
  const inner = named(expression)
  if (inner.length === 0) return ""
  return `{${inner.map((part) => canonicalText(part, part.startIndex, part.endIndex, enough)).join(" ")}}`
}

function jsxName(name: Node): string {
  return name.text.replace(/\s+/g, "")
}

function named(node: Node): Node[] {
  return node.namedChildren.filter(
    (child): child is Node => child !== null && !child.isMissing && child.type !== "comment",
  )
}

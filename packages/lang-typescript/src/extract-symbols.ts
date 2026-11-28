import { unwrapValue } from "@aburi/core"
import {
  AMBIENT_DECLARATION_DERIVED_BY,
  type ExtractionContext,
  type SymbolCandidate,
} from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import {
  AMBIENT_DECLARATION_TYPE,
  asClassValue,
  asFunctionValue,
  findChild,
  firstNonCommentChild,
  inAmbientContext,
  isExportAssignment,
  makeSourceRange,
  nameFieldText,
} from "./ast-helpers"
import {
  type CallExtractionState,
  callBodies,
  layOutBodies,
  makeCallExtractionState,
  visitCallStatement,
} from "./call-symbols"
import { addClassAndMembers, addNamedClass, makeClassCandidate } from "./class-candidates"
import { type CandidateSink, makeCandidateSink } from "./declaration-merge"
import { declaredOrDefaultQname } from "./declared-name"
import { readDecorators } from "./decorators"
import {
  exportEvidence,
  exportVisibility,
  isDefaultExport,
  isDefaultExportStatement,
  promoteDetachedExports,
  statementExportEvidence,
  topLevelVisibility,
} from "./export-evidence"
import { readLeadingJsDoc } from "./leading-jsdoc"
import { isControlStatement, makeModuleScopeCandidate, runsCode } from "./module-scope"
import { defaultExportQname, makeTsSymbolId, nestedQname } from "./qname"
import { returnedValueOf } from "./returned-value"
import { buildSignature } from "./signature"
import {
  ENUM_SHAPE,
  INTERFACE_SHAPE,
  makeSignaturelessCandidate,
  makeTypeDeclarationCandidate,
  TYPE_ALIAS_SHAPE,
} from "./type-candidates"
import { makeVariableCandidates } from "./variable-candidates"

export function extractSymbols(tree: Tree, ctx: ExtractionContext): SymbolCandidate<Node>[] {
  const root = tree.rootNode
  if (root === null) return []
  const out = makeCandidateSink()
  const state: FileState = { calls: makeCallExtractionState(), moduleScope: [] }
  for (const stmt of root.namedChildren) {
    if (stmt !== null) visitStatement(stmt, ctx, [], out, state)
  }
  const moduleScope = makeModuleScopeCandidate(state.moduleScope, ctx)
  if (moduleScope !== null) out.add(moduleScope)
  return promoteDetachedExports(root, out.list()).map(withReturnedValue)
}

function withReturnedValue(candidate: SymbolCandidate<Node>): SymbolCandidate<Node> {
  const returns = returnedValueOf(candidate)
  return returns === null ? candidate : { ...candidate, returns }
}

interface FileState {
  calls: CallExtractionState
  moduleScope: Node[]
}

function visitStatement(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
  state: FileState,
): void {
  if (node.type === "export_statement") {
    const declarationNode = exportedDeclaration(node)
    if (declarationNode === null) return
    if (isExportAssignment(node)) {
      addAssignedValue(declarationNode, node, ctx, namespacePath, out)
      return
    }
    const wrapped = wrappedDefaultValue(node, declarationNode)
    if (wrapped !== null) {
      out.add(makeWrappedDefaultCandidate(wrapped, node, ctx))
      return
    }
    visitStatement(declarationNode, ctx, namespacePath, out, state)
    return
  }
  if (node.type === AMBIENT_DECLARATION_TYPE) {
    const declarationNode = ambientDeclaration(node)
    if (declarationNode === null) return
    visitStatement(declarationNode, ctx, namespacePath, ambientSink(out), state)
    return
  }
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature":
      out.add(makeFunctionCandidate(node, ctx, namespacePath))
      return
    case "function_expression":
    case "generator_function":
    case "arrow_function":
      if (isDefaultExport(node)) {
        out.add(makeFunctionCandidate(node, ctx, namespacePath))
      }
      return
    case "class_declaration":
    case "abstract_class_declaration":
      addClassAndMembers(node, ctx, namespacePath, out)
      return
    case "class":
      // Anonymous `export default class {}` uses tree-sitter's `class` node type.
      if (isDefaultExport(node)) {
        addClassAndMembers(node, ctx, namespacePath, out)
      }
      return
    case "interface_declaration":
      out.add(makeTypeDeclarationCandidate(node, ctx, namespacePath, INTERFACE_SHAPE))
      return
    case "type_alias_declaration":
      out.add(makeTypeDeclarationCandidate(node, ctx, namespacePath, TYPE_ALIAS_SHAPE))
      return
    case "enum_declaration":
      out.add(makeTypeDeclarationCandidate(node, ctx, namespacePath, ENUM_SHAPE))
      return
    case "internal_module":
    case "module":
    case "namespace_declaration":
      addNamespaceAndBody(node, ctx, namespacePath, out, state)
      return
    case "lexical_declaration":
    case "variable_declaration":
      for (const declarator of node.namedChildren) {
        if (declarator === null || declarator.type !== "variable_declarator") continue
        for (const candidate of makeVariableCandidates(declarator, node, ctx, namespacePath)) {
          out.add(candidate)
        }
      }
      return
    case "expression_statement": {
      const wrapped = wrappedDeclaration(node)
      if (wrapped !== null) {
        visitStatement(wrapped, ctx, namespacePath, out, state)
        return
      }
      const candidate =
        namespacePath.length === 0 ? visitCallStatement(node, ctx, state.calls) : null
      if (candidate !== null) out.add(candidate)
      else if (runsCode(node)) state.moduleScope.push(node)
      return
    }
    default:
      if (isDefaultExport(node)) {
        const candidate = makeDefaultCallCandidate(node, ctx)
        if (candidate !== null) out.add(candidate)
        return
      }
      if (isControlStatement(node) && runsCode(node)) state.moduleScope.push(node)
      return
  }
}

const WRAPPED_DECLARATION_TYPES: ReadonlySet<string> = new Set(["internal_module"])

function exportedDeclaration(statement: Node): Node | null {
  return (
    statement.childForFieldName("declaration") ??
    statement.namedChildren.find(
      (c): c is Node => c !== null && c.type !== "comment" && c.type !== "decorator",
    ) ??
    null
  )
}

function wrappedDeclaration(statement: Node): Node | null {
  if (statement.namedChildCount !== 1) return null
  const only = statement.namedChild(0)
  if (only === null || !WRAPPED_DECLARATION_TYPES.has(only.type)) return null
  return only
}

function ambientDeclaration(node: Node): Node | null {
  const inner = firstNonCommentChild(node)
  if (inner === null || inner.type === "statement_block") return null
  return inner
}

const AMBIENT_DECLARATION = AMBIENT_DECLARATION_DERIVED_BY

function ambientSink(out: CandidateSink): CandidateSink {
  return {
    add(candidate) {
      if (candidate.derivedBy.includes(AMBIENT_DECLARATION)) {
        out.add(candidate)
        return
      }
      out.add({ ...candidate, derivedBy: [...candidate.derivedBy, AMBIENT_DECLARATION] })
    },
    list: () => out.list(),
  }
}

function makeFunctionCandidate(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const { qname } = declaredOrDefaultQname(node, "function", ctx, namespacePath)
  return functionCandidate(node, qname, exportEvidence(node), readLeadingJsDoc(node), ctx)
}

function functionCandidate(
  node: Node,
  qname: string,
  evidence: readonly string[],
  jsDoc: string | null,
  ctx: ExtractionContext,
): SymbolCandidate<Node> {
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "function",
    extKind: null,
    name: qname,
    visibility: exportVisibility(evidence),
    decorators: readDecorators(node),
    signature: buildSignature(node, jsDoc),
    source: makeSourceRange(node, ctx),
    derivedBy: [...evidence],
    bodyNode: node.childForFieldName("body"),
    fullNode: node,
  }
}

// A function or class expression's own name binds nothing in the module.
function wrappedDefaultValue(statement: Node, value: Node): Node | null {
  if (!isDefaultExportStatement(statement)) return null
  const unwrapped = unwrapValue(value)
  if (unwrapped.id === value.id) return null
  return asFunctionValue(unwrapped) ?? asClassValue(unwrapped)
}

function makeWrappedDefaultCandidate(
  value: Node,
  statement: Node,
  ctx: ExtractionContext,
): SymbolCandidate<Node> {
  const qname = defaultExportQname()
  const evidence = statementExportEvidence(statement)
  return value.type === "class"
    ? makeClassCandidate(value, qname, evidence, ctx)
    : functionCandidate(value, qname, evidence, readLeadingJsDoc(statement), ctx)
}

// `export =` has no declaring form, so a function or class expression's own name is the only one the
// module gives its value.
function addAssignedValue(
  value: Node,
  statement: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
): void {
  const evidence = statementExportEvidence(statement)
  const named = (node: Node) => {
    const name = nameFieldText(node)
    const qname = name === null ? defaultExportQname() : nestedQname([...namespacePath, name])
    return { name, qname }
  }
  const fn = asFunctionValue(value)
  if (fn !== null) {
    const { qname } = named(fn)
    out.add(functionCandidate(fn, qname, evidence, readLeadingJsDoc(statement), ctx))
    return
  }
  const cls = asClassValue(value)
  if (cls !== null) {
    addNamedClass(cls, named(cls), evidence, ctx, namespacePath, out)
    return
  }
  const candidate = makeDefaultCallCandidate(value, ctx)
  if (candidate !== null) out.add(candidate)
}

function makeDefaultCallCandidate(
  value: Node,
  ctx: ExtractionContext,
): SymbolCandidate<Node> | null {
  const statement = value.parent
  if (statement === null) return null
  // The statement holds the value so that the syntax string still describes it whole.
  const { bodies, evidence } = callBodies(value, statement)
  if (bodies.length === 0) return null
  const qname = defaultExportQname()
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "const",
    extKind: null,
    name: qname,
    visibility: topLevelVisibility(value),
    decorators: [],
    signature: null,
    source: makeSourceRange(statement, ctx),
    derivedBy: [...evidence, ...exportEvidence(value)],
    ...layOutBodies(bodies, statement),
  }
}

function declaredNamespaceName(node: Node, body: Node | null): string | null {
  if (body === null) return null
  const name = node.childForFieldName("name")
  if (name === null || name.isMissing || name.type === "string") return null
  return name.text.length > 0 ? name.text : null
}

function addNamespaceAndBody(
  node: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
  out: CandidateSink,
  state: FileState,
): void {
  const body = node.childForFieldName("body") ?? findChild(node, "statement_block")
  const declaredName = declaredNamespaceName(node, body)
  if (declaredName === null || body === null) return
  const [head, ...rest] = declaredName.split(".")
  if (head === undefined) return
  const path = [...namespacePath, head]
  const namespaceCandidate = () =>
    makeSignaturelessCandidate(
      node,
      ctx,
      nestedQname(path),
      "namespace",
      "namespace-declaration",
      null,
    )
  out.add(namespaceCandidate())
  const members = mergesWithClass(node, head)
    ? staticMemberSink(out, nestedQname(path), ctx.file.path)
    : out
  for (const segment of rest) {
    path.push(segment)
    members.add(namespaceCandidate())
  }
  const everyStatementUnderMember = rest.length > 0 || inAmbientContext(node)
  for (const stmt of body.namedChildren) {
    if (stmt === null) continue
    const underMember = everyStatementUnderMember || stmt.type === "export_statement"
    visitStatement(stmt, ctx, path, underMember ? members : out, state)
  }
}

function mergesWithClass(namespaceNode: Node, name: string): boolean {
  let statement = namespaceNode
  while (statement.parent !== null && !STATEMENT_LISTS.has(statement.parent.type)) {
    statement = statement.parent
  }
  const scope = statement.parent
  if (scope === null) return false
  return classNamesIn(scope).has(name)
}

// A top-level statement list is the whole file: reading it again for every namespace in it would
// make a file of many namespaces quadratic, so each list's class names are read once per tree.
const classNamesByScope = new WeakMap<Tree, Map<number, ReadonlySet<string>>>()

function classNamesIn(scope: Node): ReadonlySet<string> {
  let byScope = classNamesByScope.get(scope.tree)
  if (byScope === undefined) {
    byScope = new Map()
    classNamesByScope.set(scope.tree, byScope)
  }
  const known = byScope.get(scope.id)
  if (known !== undefined) return known
  const names = new Set<string>()
  for (const sibling of scope.namedChildren) {
    const declaration = sibling === null ? null : unwrappedDeclaration(sibling)
    if (declaration !== null) for (const name of classNamesDeclaredBy(declaration)) names.add(name)
  }
  byScope.set(scope.id, names)
  return names
}

function classNamesDeclaredBy(declaration: Node): string[] {
  if (CLASS_DECLARATION_TYPES.has(declaration.type)) {
    const declared = nameFieldText(declaration)
    return declared === null ? [] : [declared]
  }
  if (!BINDING_DECLARATION_TYPES.has(declaration.type)) return []
  const names: string[] = []
  for (const declarator of declaration.namedChildren) {
    if (declarator?.type !== "variable_declarator") continue
    const value = declarator.childForFieldName("value")
    const declared = declarator.childForFieldName("name")
    if (value === null || declared?.type !== "identifier" || asClassValue(value) === null) continue
    names.push(declared.text)
  }
  return names
}

export const STATEMENT_LISTS: ReadonlySet<string> = new Set(["program", "statement_block"])

const CLASS_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
])

const BINDING_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  "lexical_declaration",
  "variable_declaration",
])

function unwrappedDeclaration(statement: Node): Node | null {
  if (statement.type === "export_statement") {
    const declaration = exportedDeclaration(statement)
    return declaration === null ? null : unwrappedDeclaration(declaration)
  }
  if (statement.type === AMBIENT_DECLARATION_TYPE) {
    const declaration = ambientDeclaration(statement)
    return declaration === null ? null : unwrappedDeclaration(declaration)
  }
  return statement
}

function staticMemberSink(out: CandidateSink, owner: string, file: string): CandidateSink {
  const instancePrefix = `${owner}.`
  return {
    add(candidate) {
      if (!candidate.name.startsWith(instancePrefix)) {
        out.add(candidate)
        return
      }
      const name = `${owner}::${candidate.name.slice(instancePrefix.length)}`
      out.add({ ...candidate, id: makeTsSymbolId(file, name), name })
    },
    list: () => out.list(),
  }
}

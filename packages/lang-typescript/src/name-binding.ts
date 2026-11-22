import type { Node, Tree } from "web-tree-sitter"
import { firstNonCommentChild, walkDescendants } from "./ast-helpers"
import { collectPatternBindings } from "./pattern-bindings"

/**
 * The declarations a value name has in the scope nearest to `use` that declares it, and that
 * scope. `null` when no scope around `use` declares the name: a global, or a name the code never
 * declares.
 */
export interface NameBinding {
  readonly scope: Node
  readonly declarations: readonly Node[]
}

export function bindingOf(use: Node, name: string): NameBinding | null {
  let child = use
  for (let node = use.parent; node !== null; child = node, node = node.parent) {
    if (!seesScopeOf(node, child)) continue
    const declarations = scopeBindings(node).get(name)
    if (declarations !== undefined) return { scope: node, declarations }
  }
  return null
}

const FUNCTION_SCOPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
  "arrow_function",
  "method_definition",
])

const CLASS_SCOPES: ReadonlySet<string> = new Set([
  "class",
  "class_declaration",
  "abstract_class_declaration",
])

const NAMESPACE_SCOPES: ReadonlySet<string> = new Set(["internal_module", "module"])

// What a function's parameters bind, its own body and parameters see; its name and decorators are
// evaluated around it. A class's name is bound in its body.
function seesScopeOf(scope: Node, child: Node): boolean {
  if (FUNCTION_SCOPES.has(scope.type)) {
    return ["body", "parameters", "parameter"].some(
      (field) => scope.childForFieldName(field)?.id === child.id,
    )
  }
  if (CLASS_SCOPES.has(scope.type)) return scope.childForFieldName("body")?.id === child.id
  return true
}

type ScopeBindings = ReadonlyMap<string, readonly Node[]>

const EMPTY_BINDINGS: ScopeBindings = new Map()

const scopeCache = new WeakMap<Tree, Map<number, ScopeBindings>>()

function scopeBindings(scope: Node): ScopeBindings {
  let byScope = scopeCache.get(scope.tree)
  if (byScope === undefined) {
    byScope = new Map()
    scopeCache.set(scope.tree, byScope)
  }
  const cached = byScope.get(scope.id)
  if (cached !== undefined) return cached
  const found = collectScopeBindings(scope)
  byScope.set(scope.id, found)
  return found
}

function collectScopeBindings(scope: Node): ScopeBindings {
  const out = new Map<string, Node[]>()
  const bind = (name: Node, declaration: Node): void => {
    const list = out.get(name.text)
    if (list === undefined) out.set(name.text, [declaration])
    else list.push(declaration)
  }
  switch (scope.type) {
    case "program":
      for (const statement of scope.namedChildren) if (statement) bindStatement(statement, bind)
      bindVars(scope, bind)
      break
    case "statement_block":
      for (const statement of scope.namedChildren) if (statement) bindStatement(statement, bind)
      break
    case "switch_body":
      for (const clause of scope.namedChildren) {
        for (const statement of clause?.childrenForFieldName("body") ?? []) {
          if (statement) bindStatement(statement, bind)
        }
      }
      break
    case "for_statement": {
      const initializer = scope.childForFieldName("initializer")
      if (initializer?.type === "lexical_declaration") bindDeclarators(initializer, bind)
      break
    }
    case "for_in_statement": {
      const left = scope.childForFieldName("left")
      if (left !== null && scope.childForFieldName("kind")?.type !== "var") {
        bindPattern(left, scope, bind)
      }
      break
    }
    case "catch_clause": {
      const parameter = scope.childForFieldName("parameter")
      if (parameter !== null) bindPattern(parameter, scope, bind)
      break
    }
    case "class_static_block":
      bindVars(scope, bind)
      break
    case "internal_module":
    case "module": {
      const body = scope.childForFieldName("body")
      if (body !== null) bindVars(body, bind)
      break
    }
    case "class":
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = scope.childForFieldName("name")
      if (name !== null) bind(name, scope)
      break
    }
    default:
      if (FUNCTION_SCOPES.has(scope.type)) bindFunction(scope, bind)
  }
  return out.size === 0 ? EMPTY_BINDINGS : out
}

type Bind = (name: Node, declaration: Node) => void

function bindFunction(fn: Node, bind: Bind): void {
  // A function expression's own name is bound inside it, a declaration's around it.
  if (fn.type === "function_expression" || fn.type === "generator_function") {
    const name = fn.childForFieldName("name")
    if (name !== null) bind(name, fn)
  }
  const single = fn.childForFieldName("parameter")
  if (single !== null) bind(single, fn)
  for (const parameter of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (parameter === null || !PARAMETERS.has(parameter.type)) continue
    const pattern = parameter.childForFieldName("pattern")
    if (pattern !== null && pattern.type !== "this") bindPattern(pattern, parameter, bind)
  }
  const body = fn.childForFieldName("body")
  if (body?.type === "statement_block") bindVars(body, bind)
}

const PARAMETERS: ReadonlySet<string> = new Set(["required_parameter", "optional_parameter"])

function bindPattern(pattern: Node, declaration: Node, bind: Bind): void {
  for (const name of collectPatternBindings(pattern, "skip")) bind(name, declaration)
}

function bindDeclarators(declaration: Node, bind: Bind): void {
  for (const declarator of declaration.namedChildren) {
    if (declarator?.type !== "variable_declarator") continue
    const name = declarator.childForFieldName("name")
    if (name !== null) bindPattern(name, declarator, bind)
  }
}

const NAMED_DECLARATIONS: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
  "class_declaration",
  "abstract_class_declaration",
  "enum_declaration",
  "internal_module",
  "module",
])

// `var` is left to the function the statement is in (`bindVars`), which is where it is bound.
function bindStatement(statement: Node, bind: Bind): void {
  switch (statement.type) {
    case "lexical_declaration":
      bindDeclarators(statement, bind)
      return
    case "export_statement":
    case "ambient_declaration": {
      const declaration =
        statement.childForFieldName("declaration") ?? firstNonCommentChild(statement)
      if (declaration !== null && declaration.type !== "variable_declaration") {
        bindStatement(declaration, bind)
      }
      return
    }
    case "import_statement":
      for (const name of importedNames(statement)) bind(name, statement)
      return
    case "import_alias": {
      const name = firstNonCommentChild(statement)
      if (name !== null) bind(name, statement)
      return
    }
    default: {
      if (!NAMED_DECLARATIONS.has(statement.type)) return
      const name = statement.childForFieldName("name")
      if (name?.type === "identifier" || name?.type === "type_identifier") bind(name, statement)
    }
  }
}

function importedNames(statement: Node): Node[] {
  const out: Node[] = []
  for (const node of walkDescendants(statement)) {
    if (node.type === "import_specifier") {
      const local = node.childForFieldName("alias") ?? node.childForFieldName("name")
      if (local !== null) out.push(local)
    } else if (node.type === "identifier" && IMPORT_BINDERS.has(node.parent?.type ?? "")) {
      out.push(node)
    }
  }
  return out
}

const IMPORT_BINDERS: ReadonlySet<string> = new Set([
  "import_clause",
  "namespace_import",
  "import_require_clause",
])

// Every `var` the body declares, however deep in its blocks, past nested functions, classes and
// namespaces, which bind their own.
function bindVars(body: Node, bind: Bind): void {
  const descend = (node: Node): boolean => node.id === body.id || !bindsOwnVars(node)
  for (const node of walkDescendants(body, { descend })) {
    if (node.id !== body.id && bindsOwnVars(node)) continue
    if (node.type === "variable_declaration") bindDeclarators(node, bind)
    else if (node.type === "for_in_statement" && node.childForFieldName("kind")?.type === "var") {
      const left = node.childForFieldName("left")
      if (left !== null) bindPattern(left, node, bind)
    }
  }
}

function bindsOwnVars(node: Node): boolean {
  return (
    FUNCTION_SCOPES.has(node.type) || CLASS_SCOPES.has(node.type) || NAMESPACE_SCOPES.has(node.type)
  )
}

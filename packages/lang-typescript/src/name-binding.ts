import { DEFAULT_EXPORT_NAME, readStaticString } from "@aburi/core"
import type { Node, Tree } from "web-tree-sitter"
import { findChild, firstNonCommentChild, nameFieldText, walkDescendants } from "./ast-helpers"
import { collectPatternBindings } from "./pattern-bindings"

/** The scope nearest to a use that declares a value name, and the declarations it gives it. */
export interface NameBinding {
  readonly scope: Node
  readonly declarations: readonly Node[]
}

/** `null` when no scope around `use` declares the name: a global, or a name nothing declares. */
export function bindingOf(use: Node, name: string): NameBinding | null {
  let child = use
  let inParameterDecorator = false
  for (let node = use.parent; node !== null; child = node, node = node.parent) {
    if (node.type === "decorator" && PARAMETER_TYPES.has(node.parent?.type ?? "")) {
      inParameterDecorator = true
    }
    if (!seesScopeOf(node, child)) continue
    // A parameter's decorator is evaluated around the function its parameter list belongs to.
    if (inParameterDecorator && FUNCTION_SCOPES.has(node.type)) {
      inParameterDecorator = false
      continue
    }
    const declarations = scopeBindings(node).get(name)
    if (declarations !== undefined) return { scope: node, declarations }
    const ownName = ownNameOf(node)
    if (ownName?.text === name) return { scope: node, declarations: [node] }
  }
  return null
}

/**
 * The name a function or class expression `export =` makes the module's value goes by: its own,
 * unless the scope around the statement binds that name, which the expression's name never shadows.
 */
export function assignedValueName(value: Node, statement: Node): string | null {
  const written = nameFieldText(value)
  return written !== null && bindingOf(statement, written) === null ? written : null
}

export function isModuleBinding(binding: NameBinding): boolean {
  return binding.scope.type === "program"
}

/**
 * Whether the binding is one of the module's declarations: what the module or a namespace in it
 * declares, or a class's or function expression's own name inside it where the declaration around
 * it binds the same name to it.
 */
export function isModuleDeclaration(binding: NameBinding, name: string): boolean {
  if (isModuleBinding(binding) || isNamespaceBody(binding.scope)) return true
  const declaration = declarationNaming(binding, name)
  if (declaration === null) return false
  const outer = bindingOf(declaration, name)
  return (
    outer?.declarations.some((d) => d.id === declaration.id) === true &&
    isModuleDeclaration(outer, name)
  )
}

// A namespace is declared only in a module or another namespace, so what it declares is the
// module's. Its `var` is bound by the namespace, the rest by its body.
function isNamespaceBody(scope: Node): boolean {
  if (NAMESPACE_SCOPES.has(scope.type)) return true
  return scope.type === "statement_block" && NAMESPACE_SCOPES.has(scope.parent?.type ?? "")
}

const CLASS_DECLARATION_SCOPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
])

const NAMED_EXPRESSION_SCOPES: ReadonlySet<string> = new Set([
  "class",
  "function_expression",
  "generator_function",
])

// What binds a scope's own name around it: the class declaration itself, or the declarator a
// class or function expression is the value of under the same name.
function declarationNaming(binding: NameBinding, name: string): Node | null {
  const { scope, declarations } = binding
  if (declarations.length !== 1 || declarations[0]?.id !== scope.id) return null
  if (scope.childForFieldName("name")?.text !== name) return null
  if (CLASS_DECLARATION_SCOPES.has(scope.type)) return scope
  if (!NAMED_EXPRESSION_SCOPES.has(scope.type)) return null
  const declarator = scope.parent
  return declarator?.type === "variable_declarator" &&
    declarator.childForFieldName("value")?.id === scope.id &&
    declarator.childForFieldName("name")?.text === name
    ? declarator
    : null
}

/** What an import binds a name to: the module it names and what that module exports it as. */
export interface ImportedValue {
  readonly module: string
  readonly exported: string
}

/**
 * The export `use` reads: the local name of a named or default import, or a member (`nav.redirect`)
 * of a module bound whole, by `import * as nav` or `import nav = require(…)`. `null` for any other
 * use, and unless the name's only binding is a module-scope import.
 */
export function importedValueOf(use: Node): ImportedValue | null {
  if (use.type === "identifier") {
    return importedThrough(use, (statement) => exportedAs(statement, use.text))
  }
  if (use.type !== "member_expression") return null
  const object = use.childForFieldName("object")
  const property = use.childForFieldName("property")
  if (object?.type !== "identifier" || property?.type !== "property_identifier") return null
  return importedThrough(object, (statement) =>
    namespaceNameOf(statement)?.text === object.text ? property.text : null,
  )
}

function importedThrough(
  name: Node,
  exportedFrom: (statement: Node) => string | null,
): ImportedValue | null {
  const binding = bindingOf(name, name.text)
  const [statement, ...others] = binding?.declarations ?? []
  if (binding === null || !isModuleBinding(binding) || others.length > 0) return null
  if (statement?.type !== "import_statement") return null
  const specifier =
    statement.childForFieldName("source") ??
    findChild(findChild(statement, "import_require_clause") ?? statement, "string")
  const module = specifier === null ? null : readStaticString(specifier)
  const exported = exportedFrom(statement)
  return module === null || exported === null ? null : { module, exported }
}

function exportedAs(statement: Node, local: string): string | null {
  const clause = findChild(statement, "import_clause")
  for (const part of clause?.namedChildren ?? []) {
    if (part?.type === "identifier" && part.text === local) return DEFAULT_EXPORT_NAME
    if (part?.type !== "named_imports") continue
    for (const specifier of part.namedChildren) {
      if (specifier?.type !== "import_specifier") continue
      const name = specifier.childForFieldName("name")
      const alias = specifier.childForFieldName("alias")
      if (name === null || (alias ?? name).text !== local) continue
      return name.type === "string" ? readStaticString(name) : name.text
    }
  }
  return null
}

function namespaceNameOf(statement: Node): Node | null {
  const clause = findChild(statement, "import_clause")
  const namespace = clause === null ? null : findChild(clause, "namespace_import")
  if (namespace !== null) return findChild(namespace, "identifier")
  const required = findChild(statement, "import_require_clause")
  return required === null ? null : findChild(required, "identifier")
}

export const PARAMETER_TYPES: ReadonlySet<string> = new Set([
  "required_parameter",
  "optional_parameter",
])

// A function expression's own name is bound in a scope between its parameters and the code
// around it, so a parameter or a `var` of that name hides it.
function ownNameOf(scope: Node): Node | null {
  if (scope.type !== "function_expression" && scope.type !== "generator_function") return null
  return scope.childForFieldName("name")
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
  const single = fn.childForFieldName("parameter")
  if (single !== null) bind(single, fn)
  for (const parameter of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (parameter === null || !PARAMETER_TYPES.has(parameter.type)) continue
    const pattern = parameter.childForFieldName("pattern")
    if (pattern !== null && pattern.type !== "this") bindPattern(pattern, parameter, bind)
  }
  const body = fn.childForFieldName("body")
  if (body?.type === "statement_block") bindVars(body, bind)
}

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

// A `var` is bound by the function, namespace, static block or module around it (`bindVars`).
function bindStatement(statement: Node, bind: Bind): void {
  switch (statement.type) {
    case "lexical_declaration":
      bindDeclarators(statement, bind)
      return
    case "expression_statement": {
      // The grammar reads a namespace no `export` or `declare` leads as an expression.
      const written = firstNonCommentChild(statement)
      if (written !== null && NAMESPACE_SCOPES.has(written.type)) {
        bindStatement(written, bind)
        return
      }
      const declaration = usingDeclaration(statement)
      const name = declaration?.childForFieldName("left")
      if (declaration != null && name != null) bindPattern(name, declaration, bind)
      return
    }
    case "export_statement":
    case "ambient_declaration": {
      const declaration =
        statement.childForFieldName("declaration") ?? firstNonCommentChild(statement)
      if (declaration === null || declaration.type === "variable_declaration") return
      // `declare global { … }` declares its names in the scope every module sees.
      if (declaration.type === "statement_block") {
        for (const inner of declaration.namedChildren)
          if (inner !== null) bindStatement(inner, bind)
        return
      }
      bindStatement(declaration, bind)
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

// The grammar reads `using x = open()` and `await using x = open()` as an assignment.
function usingDeclaration(statement: Node): Node | null {
  let expression = firstNonCommentChild(statement)
  if (expression?.type === "await_expression") expression = firstNonCommentChild(expression)
  if (expression?.type !== "assignment_expression") return null
  return expression.children.some((child) => child?.type === "using") ? expression : null
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

// Every `var` the body declares, however deep in its blocks, but not in a nested function,
// namespace, or a class's methods and static blocks, which bind their own.
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

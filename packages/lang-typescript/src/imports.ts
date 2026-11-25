import {
  compareCodeUnit,
  DEFAULT_EXPORT_NAME,
  readStaticString,
  splitAliasedImportName,
} from "@aburi/core"
import type { ImportEdge, ParseError, Reexport } from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import { findChild, firstNonCommentChild } from "./ast-helpers"
import { maskedImportSpecifier, masksImportTypes } from "./import-type-reparse"
import { bindingOf, isModuleBinding } from "./name-binding"

export interface ImportExtraction {
  edges: ImportEdge[]
  errors: ParseError[]
}

export function extractImports(tree: Tree, _source: string): ImportExtraction {
  const edges: ImportEdge[] = []
  const errors: ParseError[] = []
  const root = tree.rootNode
  if (root === null) return { edges, errors }

  const imports: ImportEdge[] = []
  const exportedLocals = new Map<string, string[]>()
  const boundRequires = new Set<number>()
  for (const child of root.namedChildren) {
    if (child === null) continue
    if (child.type === "import_statement") {
      for (const edge of readImportStatement(child, errors)) imports.push(edge)
    } else if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      for (const edge of readRequireDeclaration(child, boundRequires, errors)) imports.push(edge)
    } else if (child.type === "export_statement") {
      const declaration = child.childForFieldName("declaration")
      if (
        declaration?.type === "lexical_declaration" ||
        declaration?.type === "variable_declaration"
      ) {
        for (const edge of readRequireDeclaration(declaration, boundRequires, errors)) {
          imports.push(edge)
          // The declaration exports each name it binds under that name.
          for (const local of boundLocals(edge)) addExportedLocal(exportedLocals, local, local)
        }
      }
      if (child.childForFieldName("source") === null) readLocalExports(child, exportedLocals)
      else {
        const edge = readReExport(child, errors)
        if (edge !== null) edges.push(edge)
      }
    }
  }
  for (const edge of imports) edges.push(withRepublished(edge, exportedLocals))

  // A module loaded at run time can be written anywhere in the tree, so scan the whole thing.
  walkForDynamicImports(tree, boundRequires, edges, errors)

  edges.sort((a, b) => a.line - b.line || compareCodeUnit(a.source, b.source))
  errors.sort((a, b) => a.line - b.line || a.column - b.column)
  return { edges: dedupeEdges(edges), errors }
}

function addExportedLocal(
  exportedLocals: Map<string, string[]>,
  local: string,
  exported: string,
): void {
  const names = exportedLocals.get(local)
  if (names === undefined) exportedLocals.set(local, [exported])
  else names.push(exported)
}

function boundLocals(edge: ImportEdge): string[] {
  if (edge.symbols === "*")
    return edge.namespaceBinding === undefined ? [] : [edge.namespaceBinding]
  return edge.symbols.map((raw) => splitAliasedImportName(raw).local)
}

function readLocalExports(node: Node, exportedLocals: Map<string, string[]>): void {
  const add = (local: string, exported: string): void =>
    addExportedLocal(exportedLocals, local, exported)
  const value = node.childForFieldName("value")
  if (value !== null) {
    if (value.type === "identifier") add(value.text, DEFAULT_EXPORT_NAME)
    return
  }
  if (isTypeOnly(node)) return
  const clause = findChild(node, "export_clause")
  if (clause === null) return
  for (const spec of exportSpecifiers(clause)) add(spec.name, spec.exported)
}

function withRepublished(
  edge: ImportEdge,
  exportedLocals: ReadonlyMap<string, readonly string[]>,
): ImportEdge {
  if (exportedLocals.size === 0) return edge
  const reexports: Reexport[] = []
  const republish = (local: string, imported: string): void => {
    for (const exported of exportedLocals.get(local) ?? []) reexports.push({ imported, exported })
  }
  if (edge.symbols === "*") {
    if (edge.namespaceBinding !== undefined) republish(edge.namespaceBinding, "*")
  } else {
    for (const raw of edge.symbols) {
      const binding = splitAliasedImportName(raw)
      republish(binding.local, binding.imported)
    }
  }
  return reexports.length === 0 ? edge : { ...edge, reexports }
}

function isTypeOnly(node: Node): boolean {
  return node.children.some(
    (child) => child !== null && (child.type === "type" || isTypeStarKeyword(child)),
  )
}

/**
 * The `type` of TypeScript 5.0's `export type * from` and `export type * as ns from`, which the
 * grammar has no rule for and parks in an ERROR between `export` and the rest of the statement.
 */
export function isTypeStarKeyword(node: Node): boolean {
  if (!node.isError || node.childCount !== 1 || node.child(0)?.type !== "type") return false
  const statement = node.parent
  if (statement?.type !== "export_statement" || statement.childForFieldName("source") === null) {
    return false
  }
  const next = node.nextSibling?.type
  return node.previousSibling?.type === "export" && (next === "*" || next === "namespace_export")
}

/** The clause's value specifiers: a type-only one exports nothing a decorator or call can name. */
function exportSpecifiers(clause: Node): { name: string; exported: string }[] {
  const specs: { name: string; exported: string }[] = []
  for (const spec of clause.namedChildren) {
    if (spec === null || spec.type !== "export_specifier" || isTypeOnly(spec)) continue
    const name = spec.childForFieldName("name")
    if (name === null || name.type !== "identifier") continue
    const alias = spec.childForFieldName("alias")
    if (alias !== null && alias.type !== "identifier") continue
    specs.push({ name: name.text, exported: alias?.text ?? name.text })
  }
  return specs
}

function readImportStatement(node: Node, errors: ParseError[]): ImportEdge[] {
  const requireClause = findChild(node, "import_require_clause")
  if (requireClause !== null) return readRequireClause(node, requireClause, errors)

  const source = readModuleSpecifier(node.childForFieldName("source"), "import", errors)
  if (source === null) return []
  const line = node.startPosition.row + 1
  const clause = node.childForFieldName("import_clause") ?? findChild(node, "import_clause")
  if (clause === null) {
    return [{ source, symbols: "*", line, dynamic: false }]
  }
  const { names, namespaceBinding } = readImportClauseParts(clause)
  const edges: ImportEdge[] = []
  if (names.length > 0) edges.push({ source, symbols: names, line, dynamic: false })
  if (namespaceBinding !== null) {
    edges.push({
      source,
      symbols: "*",
      line,
      dynamic: false,
      namespaceBinding,
    })
  }
  if (edges.length === 0) edges.push({ source, symbols: "*", line, dynamic: false })
  return edges
}

function readRequireClause(statement: Node, clause: Node, errors: ParseError[]): ImportEdge[] {
  if (clause.hasError) return []
  const source = readModuleSpecifier(findChild(clause, "string"), "import", errors)
  if (source === null) return []
  const line = statement.startPosition.row + 1
  const binding = findChild(clause, "identifier")
  if (binding === null) return [{ source, symbols: "*", line, dynamic: false }]
  return [{ source, symbols: "*", line, dynamic: false, namespaceBinding: binding.text }]
}

/**
 * The edges of a top-level `const`, `let` or `var` whose initializer is a `require()`, or a property
 * read straight off one: CommonJS's import, binding the names an import would.
 */
function readRequireDeclaration(
  statement: Node,
  boundRequires: Set<number>,
  errors: ParseError[],
): ImportEdge[] {
  const edges: ImportEdge[] = []
  const line = statement.startPosition.row + 1
  for (const declarator of statement.namedChildren) {
    if (declarator?.type !== "variable_declarator") continue
    const binding = declarator.childForFieldName("name")
    const value = declarator.childForFieldName("value")
    if (binding === null || value === null) continue
    const required = requiredValue(value)
    if (required === null) continue
    boundRequires.add(required.call.id)
    const source = readModuleSpecifier(required.specifier, "require", errors)
    if (source === null) continue
    edges.push({ source, line, dynamic: false, ...requireBindings(binding, required.property) })
  }
  return edges
}

interface RequiredValue {
  readonly call: Node
  readonly specifier: Node
  /** The property read off what the call gives back, `null` for the module object itself. */
  readonly property: string | null
}

function requiredValue(value: Node): RequiredValue | null {
  const whole = requireSpecifier(value)
  if (whole !== null) return { call: value, specifier: whole, property: null }
  const object = value.childForFieldName("object")
  if (object === null) return null
  const specifier = requireSpecifier(object)
  if (specifier === null) return null
  const property = propertyRead(value)
  return property === null ? null : { call: object, specifier, property }
}

function propertyRead(access: Node): string | null {
  if (access.type === "member_expression") {
    const property = access.childForFieldName("property")
    return property?.type === "property_identifier" ? property.text : null
  }
  if (access.type !== "subscript_expression") return null
  const index = access.childForFieldName("index")
  return index === null ? null : bindableKey(readStaticString(index))
}

// An import binding spells the name it takes, so a key no identifier spells is taken by none.
const IDENTIFIER_NAME = /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u

function bindableKey(key: string | null): string | null {
  return key !== null && IDENTIFIER_NAME.test(key) ? key : null
}

/**
 * The argument of a call of the bare `require` given exactly one, read past comments. A `require`
 * the module binds itself is `createRequire`'s, and one a function binds is its own.
 */
function requireSpecifier(call: Node): Node | null {
  if (call.type !== "call_expression") return null
  const callee = call.childForFieldName("function")
  if (callee?.type !== "identifier" || callee.text !== "require") return null
  const binding = bindingOf(callee, callee.text)
  if (binding !== null && !isModuleBinding(binding)) return null
  const args = call.childForFieldName("arguments")
  if (args?.type !== "arguments") return null
  const values = args.namedChildren.filter((arg) => arg !== null && arg.type !== "comment")
  return values.length === 1 ? (values[0] ?? null) : null
}

/**
 * What the declaration binds: the module object under a name, as `import x = require()` binds it;
 * the names a destructuring or a property read takes from it, as named imports; or nothing a later
 * call could reach, as a side-effect import.
 */
function requireBindings(
  binding: Node,
  property: string | null,
): Pick<ImportEdge, "symbols" | "namespaceBinding"> {
  if (binding.type === "identifier") {
    if (property === null) return { symbols: "*", namespaceBinding: binding.text }
    return { symbols: [importedAs(property, binding.text)] }
  }
  if (property !== null || binding.type !== "object_pattern") return { symbols: "*" }
  const names = destructuredNames(binding)
  return { symbols: names.length > 0 ? names : "*" }
}

function destructuredNames(pattern: Node): string[] {
  const names: string[] = []
  for (const entry of pattern.namedChildren) {
    if (entry === null) continue
    if (entry.type === "shorthand_property_identifier_pattern") names.push(entry.text)
    else if (entry.type === "object_assignment_pattern") {
      const left = entry.childForFieldName("left")
      if (left?.type === "shorthand_property_identifier_pattern") names.push(left.text)
    } else if (entry.type === "pair_pattern") {
      const name = destructuredPair(entry)
      if (name !== null) names.push(name)
    }
  }
  return names
}

function destructuredPair(pair: Node): string | null {
  const key = pair.childForFieldName("key")
  const imported =
    key === null
      ? null
      : key.type === "property_identifier"
        ? key.text
        : bindableKey(readStaticString(key))
  if (imported === null) return null
  let local = pair.childForFieldName("value")
  if (local?.type === "assignment_pattern") local = local.childForFieldName("left")
  return local?.type === "identifier" ? importedAs(imported, local.text) : null
}

function importedAs(imported: string, local: string): string {
  return imported === local ? imported : `${imported} as ${local}`
}

function readImportClauseParts(clause: Node): {
  names: string[]
  namespaceBinding: string | null
} {
  const names: string[] = []
  let namespaceBinding: string | null = null
  for (const child of clause.namedChildren) {
    if (child === null) continue
    switch (child.type) {
      case "namespace_import": {
        const alias = findChild(child, "identifier")
        if (alias !== null) namespaceBinding = alias.text
        break
      }
      case "identifier":
        names.push(`${DEFAULT_EXPORT_NAME} as ${child.text}`)
        break
      case "named_imports":
        for (const spec of child.namedChildren) {
          if (spec === null || spec.type !== "import_specifier") continue
          const exportedName = spec.childForFieldName("name")
          if (exportedName === null || exportedName.type !== "identifier") continue
          const aliasNode = spec.childForFieldName("alias")
          if (aliasNode !== null && aliasNode.type === "identifier") {
            names.push(`${exportedName.text} as ${aliasNode.text}`)
          } else {
            names.push(exportedName.text)
          }
        }
        break
    }
  }
  return { names, namespaceBinding }
}

function readReExport(node: Node, errors: ParseError[]): ImportEdge | null {
  const source = readModuleSpecifier(node.childForFieldName("source"), "re-export", errors)
  if (source === null) return null
  const line = node.startPosition.row + 1

  const namespaceExport = findChild(node, "namespace_export")
  if (namespaceExport !== null) {
    const name = findChild(namespaceExport, "identifier")
    return name === null || isTypeOnly(node)
      ? { source, symbols: "*", line, dynamic: false }
      : {
          source,
          symbols: "*",
          line,
          dynamic: false,
          reexports: [{ imported: "*", exported: name.text }],
        }
  }

  const clauseNode = findChild(node, "export_clause")
  if (clauseNode === null) {
    const edge: ImportEdge = { source, symbols: "*", line, dynamic: false }
    return isTypeOnly(node) ? edge : { ...edge, reexportsAll: true }
  }
  const names: string[] = []
  for (const spec of clauseNode.namedChildren) {
    if (spec === null || spec.type !== "export_specifier") continue
    const name = spec.childForFieldName("name")
    if (name !== null && name.type === "identifier") names.push(name.text)
  }
  const reexports = isTypeOnly(node)
    ? []
    : exportSpecifiers(clauseNode).map((spec) => ({ imported: spec.name, exported: spec.exported }))
  const edge: ImportEdge = { source, symbols: names.length > 0 ? names : "*", line, dynamic: false }
  return reexports.length === 0 ? edge : { ...edge, reexports }
}

// `import()` and a `require()` no top-level declaration binds: neither binds a name of the module.
// The grammar finds the nodes itself: a walk would build a node object for every node in the file.
function walkForDynamicImports(
  tree: Tree,
  boundRequires: ReadonlySet<number>,
  edges: ImportEdge[],
  errors: ParseError[],
): void {
  // Identifiers are most of a file's nodes, and only a tree whose import() types were masked has
  // one to read.
  const types = masksImportTypes(tree) ? ["call_expression", "identifier"] : ["call_expression"]
  for (const node of tree.rootNode.descendantsOfType(types)) {
    if (node === null) continue
    const masked = node.type === "identifier" ? maskedImportSpecifier(node) : undefined
    if (masked !== undefined) {
      edges.push({ source: masked, symbols: "*", line: node.startPosition.row + 1, dynamic: true })
    }
    if (node.type !== "call_expression") continue
    const callee = node.childForFieldName("function")
    if (callee?.type === "identifier" && !boundRequires.has(node.id)) {
      const required = requireSpecifier(node)
      const source = required === null ? null : readModuleSpecifier(required, "require", errors)
      if (source !== null) {
        edges.push({ source, symbols: "*", line: node.startPosition.row + 1, dynamic: false })
      }
      continue
    }
    if (callee === null || callee.type !== "import") continue
    const args = node.childForFieldName("arguments")
    const specifier =
      args !== null
        ? readModuleSpecifier(firstNonCommentChild(args), "dynamic import", errors)
        : null
    if (specifier === null) continue
    edges.push({ source: specifier, symbols: "*", line: node.startPosition.row + 1, dynamic: true })
  }
}

function readModuleSpecifier(
  node: Node | null,
  site: ImportSite,
  errors: ParseError[],
): string | null {
  if (node === null) return null
  const specifier = readStaticString(node)
  if (specifier === null) return null
  if (specifier.length > 0) return specifier
  errors.push({
    message: `empty module specifier: this ${site} names no module — write one, or remove the ${site}`,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    recoverable: true,
  })
  return null
}

type ImportSite = "import" | "re-export" | "dynamic import" | "require"

function dedupeEdges(edges: readonly ImportEdge[]): ImportEdge[] {
  const seen = new Set<string>()
  const out: ImportEdge[] = []
  for (const edge of edges) {
    const symbolsKey =
      edge.symbols === "*" ? '"*"' : JSON.stringify([...edge.symbols].sort(compareCodeUnit))
    const reexportsKey = JSON.stringify(edge.reexports ?? [])
    const key = `${edge.line}\t${edge.source}\t${edge.dynamic}\t${symbolsKey}\t${edge.namespaceBinding ?? ""}\t${reexportsKey}\t${edge.reexportsAll === true}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(edge)
  }
  return out
}

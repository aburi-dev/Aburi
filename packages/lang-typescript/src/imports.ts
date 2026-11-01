import { compareCodeUnit, DEFAULT_EXPORT_NAME, splitAliasedImportName } from "@aburi/core"
import type { ImportEdge, ParseError, Reexport } from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import { findChild, firstNonCommentChild, walkDescendants } from "./ast-helpers"
import { maskedImportSpecifier } from "./import-type-reparse"
import { readStaticString } from "./string-escape"

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
  for (const child of root.namedChildren) {
    if (child === null) continue
    if (child.type === "import_statement") {
      for (const edge of readImportStatement(child, errors)) imports.push(edge)
    } else if (child.type === "export_statement") {
      if (child.childForFieldName("source") === null) readLocalExports(child, exportedLocals)
      else {
        const edge = readReExport(child, errors)
        if (edge !== null) edges.push(edge)
      }
    }
  }
  for (const edge of imports) edges.push(withRepublished(edge, exportedLocals))

  // Dynamic imports can appear anywhere in the tree, so scan the whole thing separately.
  walkForDynamicImports(root, edges, errors)

  edges.sort((a, b) => a.line - b.line || compareCodeUnit(a.source, b.source))
  errors.sort((a, b) => a.line - b.line || a.column - b.column)
  return { edges: dedupeEdges(edges), errors }
}

function readLocalExports(node: Node, exportedLocals: Map<string, string[]>): void {
  const add = (local: string, exported: string): void => {
    const names = exportedLocals.get(local)
    if (names === undefined) exportedLocals.set(local, [exported])
    else names.push(exported)
  }
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
  return node.children.some((child) => child?.type === "type")
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
    return { source, symbols: "*", line, dynamic: false }
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

function walkForDynamicImports(root: Node, edges: ImportEdge[], errors: ParseError[]): void {
  for (const node of walkDescendants(root)) {
    const masked = node.type === "identifier" ? maskedImportSpecifier(node) : undefined
    if (masked !== undefined) {
      edges.push({ source: masked, symbols: "*", line: node.startPosition.row + 1, dynamic: true })
    }
    if (node.type !== "call_expression") continue
    const callee = node.childForFieldName("function")
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

type ImportSite = "import" | "re-export" | "dynamic import"

function dedupeEdges(edges: readonly ImportEdge[]): ImportEdge[] {
  const seen = new Set<string>()
  const out: ImportEdge[] = []
  for (const edge of edges) {
    const symbolsKey =
      edge.symbols === "*" ? '"*"' : JSON.stringify([...edge.symbols].sort(compareCodeUnit))
    const reexportsKey = JSON.stringify(edge.reexports ?? [])
    const key = `${edge.line}\t${edge.source}\t${edge.dynamic}\t${symbolsKey}\t${edge.namespaceBinding ?? ""}\t${reexportsKey}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(edge)
  }
  return out
}

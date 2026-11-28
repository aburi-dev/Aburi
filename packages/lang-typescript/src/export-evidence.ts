import { DEFAULT_EXPORT_NAME, readStaticString, unwrapValue } from "@aburi/core"
import {
  EXPORT_ASSIGNMENT_DERIVED_BY,
  EXPORT_CLAUSE_DERIVED_BY_PREFIX,
  EXPORT_DEFAULT_DERIVED_BY,
  EXPORT_KEYWORD_DERIVED_BY,
  type SymbolCandidate,
  type SymbolKind,
  type Visibility,
} from "@aburi/types"
import type { Node } from "web-tree-sitter"
import {
  findChild,
  firstNonCommentChild,
  hasChildOfType,
  isExportAssignment,
  statementParent,
} from "./ast-helpers"
import { hasPrivateName } from "./class-members"

export function exportEvidence(node: Node): string[] {
  return statementExportEvidence(statementParent(node))
}

// Takes the statement: a wrapped default export's value has the wrapper, not the statement, for a
// parent.
export function statementExportEvidence(statement: Node | null): string[] {
  if (statement?.type !== "export_statement") return []
  if (isExportAssignment(statement)) return [EXPORT_ASSIGNMENT_DERIVED_BY]
  return [
    isDefaultExportStatement(statement) ? EXPORT_DEFAULT_DERIVED_BY : EXPORT_KEYWORD_DERIVED_BY,
  ]
}

export function topLevelVisibility(node: Node): Visibility {
  return exportVisibility(exportEvidence(node))
}

export function exportVisibility(evidence: readonly string[]): Visibility {
  return evidence.length > 0 ? "public" : "internal"
}

export function memberVisibility(member: Node): Visibility {
  return hasPrivateName(member) ? "private" : accessibilityOf(member)
}

function accessibilityOf(node: Node): Visibility {
  const modifier = findChild(node, "accessibility_modifier")
  if (modifier === null) return "public"
  switch (modifier.text) {
    case "private":
      return "private"
    case "protected":
      return "protected"
    default:
      return "public"
  }
}

export function isDefaultExport(node: Node): boolean {
  return isDefaultExportStatement(statementParent(node))
}

/** The `default` an `export_statement` is written with is an anonymous token, hence the child scan. */
export function isDefaultExportStatement(statement: Node | null): boolean {
  return statement?.type === "export_statement" && hasChildOfType(statement, "default")
}

export function promoteDetachedExports(
  root: Node,
  candidates: SymbolCandidate<Node>[],
): SymbolCandidate<Node>[] {
  const exported = detachedExportsByLocalName(root)
  if (exported.size === 0) return candidates
  return candidates.map((candidate): SymbolCandidate<Node> => {
    if (candidate.kind === "call") return candidate
    const added = (exported.get(candidate.name) ?? [])
      .filter((name) => !name.typeOnly || TYPE_ONLY_KINDS.has(candidate.kind))
      .map((name) => name.token)
      .filter((token) => !candidate.derivedBy.includes(token))
    if (added.length === 0) return candidate
    return { ...candidate, visibility: "public", derivedBy: [...candidate.derivedBy, ...added] }
  })
}

// A type-only export is erased: it exports a declaration that is only a type, and no value.
const TYPE_ONLY_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["interface", "type"])

interface ExportedName {
  readonly token: string
  readonly typeOnly: boolean
}

function detachedExportsByLocalName(root: Node): ReadonlyMap<string, readonly ExportedName[]> {
  const exported = new Map<string, ExportedName[]>()
  const record = (local: string, token: string, typeOnly: boolean): void => {
    let names = exported.get(local)
    if (names === undefined) {
      names = []
      exported.set(local, names)
    }
    const index = names.findIndex((name) => name.token === token)
    if (index < 0) names.push({ token, typeOnly })
    else if (!typeOnly) names[index] = { token, typeOnly }
  }
  for (const stmt of root.namedChildren) {
    if (stmt === null || stmt.type !== "export_statement") continue
    // A re-export binds nothing here, so a declaration sharing one of its names is not what it exports.
    if (stmt.childForFieldName("source") !== null) continue
    const clause = findChild(stmt, "export_clause")
    if (clause !== null) {
      const typeOnlyClause = hasChildOfType(stmt, "type")
      for (const specifier of clause.namedChildren) {
        if (specifier === null || specifier.type !== "export_specifier") continue
        const local = specifier.childForFieldName("name")
        if (local === null || local.type !== "identifier") continue
        const as = moduleExportName(specifier.childForFieldName("alias") ?? local)
        const typeOnly = typeOnlyClause || hasChildOfType(specifier, "type")
        if (as !== null) record(local.text, clauseToken(as), typeOnly)
      }
      continue
    }
    const local = detachedExportLocal(stmt)
    if (local === null) continue
    record(
      local,
      isExportAssignment(stmt) ? EXPORT_ASSIGNMENT_DERIVED_BY : EXPORT_DEFAULT_DERIVED_BY,
      false,
    )
  }
  return exported
}

function clauseToken(as: string): string {
  return as === DEFAULT_EXPORT_NAME
    ? EXPORT_DEFAULT_DERIVED_BY
    : `${EXPORT_CLAUSE_DERIVED_BY_PREFIX}${as}`
}

/** The local `export default h` or `export = h` names, read through the wrappers it is written behind. */
export function detachedExportLocal(statement: Node): string | null {
  const value = exportedValue(statement)
  const inner = value === null ? null : unwrapValue(value)
  return inner?.type === "identifier" ? inner.text : null
}

// The grammar gives `export default`'s value a field and `export =`'s none.
function exportedValue(statement: Node): Node | null {
  if (isDefaultExportStatement(statement)) return statement.childForFieldName("value")
  return isExportAssignment(statement) ? firstNonCommentChild(statement) : null
}

function moduleExportName(node: Node): string | null {
  return node.type === "identifier" ? node.text : readStaticString(node)
}

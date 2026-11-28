import type { Decorator, ImportBinding, ImportEdge } from "@aburi/types"

export type { ImportBinding }

export const DEFAULT_EXPORT_NAME = "default"

export function splitAliasedImportName(raw: string): ImportBinding {
  const marker = " as "
  const idx = raw.indexOf(marker)
  if (idx < 0) {
    const only = raw.trim()
    return { imported: only, local: only }
  }
  const imported = raw.slice(0, idx).trim()
  const local = raw.slice(idx + marker.length).trim()
  return { imported, local }
}

/** Whether a static edge binds `local`: as a named or default import's name, or a whole module's. */
export function importBindsLocal(edge: ImportEdge, local: string): boolean {
  if (edge.dynamic) return false
  if (edge.symbols === "*") return edge.namespaceBinding === local
  return edge.symbols.some((raw) => splitAliasedImportName(raw).local === local)
}

export function reexportsAny(edge: ImportEdge): boolean {
  return edge.reexportsAll === true || (edge.reexports?.length ?? 0) > 0
}

export interface DecoratorReference {
  /** The local the decorator is read through: its name, or its receiver's first segment. */
  readonly head: string
  /** The name it reads from the module `head` binds, when `head` binds a whole module. */
  readonly member: string
}

/** One reading for the core, which follows the name, and the framework plugins, which grade it. */
export function decoratorReference(
  decorator: Pick<Decorator, "name" | "qualifier">,
): DecoratorReference {
  if (decorator.qualifier === undefined) return { head: decorator.name, member: decorator.name }
  const [head = decorator.qualifier, member = decorator.name] = decorator.qualifier.split(".")
  return { head, member }
}

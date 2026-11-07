import type { Decorator, ImportBinding } from "@aburi/types"

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

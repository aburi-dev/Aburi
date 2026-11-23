import { splitAliasedImportName } from "@aburi/core"
import type { ImportEdge } from "@aburi/types"

// Preact's compatibility layer is React's API under another module name.
function isReactModule(source: string): boolean {
  return (
    source === "react" ||
    source.startsWith("react/") ||
    source === "preact/compat" ||
    source.startsWith("preact/compat/")
  )
}

export function importsReact(imports: readonly ImportEdge[]): boolean {
  return imports.some((edge) => isReactModule(edge.source))
}

/** True when an import from React binds `local`, as `import React from "react"` binds `React`. */
export function isReactBinding(imports: readonly ImportEdge[], local: string): boolean {
  return imports.some((edge) => isReactModule(edge.source) && bindsLocal(edge, local))
}

function bindsLocal(edge: ImportEdge, local: string): boolean {
  if (edge.symbols === "*") return edge.namespaceBinding === local
  return edge.symbols.some((raw) => splitAliasedImportName(raw).local === local)
}

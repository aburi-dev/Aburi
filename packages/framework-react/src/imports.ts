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

const COMPOSABLE_MODULES: ReadonlySet<string> = new Set([
  "vue",
  "vue-router",
  "pinia",
  "nuxt",
  "#app",
  "#imports",
  "solid-js",
])

const COMPOSABLE_MODULE_PREFIXES: readonly string[] = [
  "@vue/",
  "@vueuse/",
  "nuxt/",
  "solid-js/",
  "@solidjs/",
]

export function importsReact(imports: readonly ImportEdge[]): boolean {
  return imports.some((edge) => isReactModule(edge.source))
}

// Vue's and Solid's composables are named as React's hooks are, and call one another.
export function importsComposables(imports: readonly ImportEdge[]): boolean {
  return imports.some(
    ({ source }) =>
      COMPOSABLE_MODULES.has(source) ||
      COMPOSABLE_MODULE_PREFIXES.some((prefix) => source.startsWith(prefix)),
  )
}

/** True when an import from React binds `local`, as `import React from "react"` binds `React`. */
export function isReactBinding(imports: readonly ImportEdge[], local: string): boolean {
  return imports.some((edge) => isReactModule(edge.source) && bindsLocal(edge, local))
}

export function isImportBinding(imports: readonly ImportEdge[], local: string): boolean {
  return imports.some((edge) => bindsLocal(edge, local))
}

function bindsLocal(edge: ImportEdge, local: string): boolean {
  if (edge.symbols === "*") return edge.namespaceBinding === local
  return edge.symbols.some((raw) => splitAliasedImportName(raw).local === local)
}

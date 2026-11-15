import { DEFAULT_EXPORT_NAME, decoratorReference, splitAliasedImportName } from "@aburi/core"
import {
  assertImportBinding,
  assertImportEdgeSource,
  assertNamespaceBinding,
  type PluginInputOrigin,
} from "@aburi/plugin-registry/plugin-input"
import type { Confidence, Decorator, ImportEdge } from "@aburi/types"
import { FRAMEWORK_NESTJS_PLUGIN_NAME } from "./manifest"

const NESTJS_SCOPE = "@nestjs/"

export function isNestjsModule(source: string): boolean {
  return source.startsWith(NESTJS_SCOPE)
}

/** How far an edge's module is trusted to be NestJS's, best first. */
type Provenance = "nestjs" | "unfollowed" | "foreign"

const RANK: Readonly<Record<Provenance, number>> = { nestjs: 0, unfollowed: 1, foreign: 2 }

// Only the scan's origins place a module outside the workspace; a specifier as written may name a
// barrel or a workspace package.
const CONFIDENCE: Readonly<Record<Provenance, Confidence | null>> = {
  nestjs: "high",
  unfollowed: "medium",
  foreign: null,
}

interface NameOrigin {
  readonly imported: string
  /** The module specifier the name came from, kept so a downgrade can say which module caused it. */
  readonly source: string
  readonly provenance: Provenance
}

type NamespaceOrigin = Pick<ImportEdge, "source" | "origins">

export interface ImportedBindings {
  /** A name the edges never mention is absent, unlike one attributed to a foreign module. */
  readonly names: ReadonlyMap<string, NameOrigin>
  /** Every namespace edge that binds the name: which one ranks best depends on the member read. */
  readonly namespaces: ReadonlyMap<string, readonly NamespaceOrigin[]>
}

export function readImportedNames(
  imports: readonly ImportEdge[],
  filePath: string,
): ImportedBindings {
  const origin: PluginInputOrigin = { plugin: FRAMEWORK_NESTJS_PLUGIN_NAME, filePath }
  const names = new Map<string, NameOrigin>()
  const namespaces = new Map<string, NamespaceOrigin[]>()

  for (const edge of imports) {
    assertImportEdgeSource(edge, origin)
    if (edge.symbols === "*") {
      const binding = edge.namespaceBinding
      if (binding === undefined) continue
      assertNamespaceBinding(binding, edge, origin)
      const earlier = namespaces.get(binding)
      if (earlier === undefined) namespaces.set(binding, [edge])
      else earlier.push(edge)
      continue
    }
    for (const raw of edge.symbols) {
      const binding = splitAliasedImportName(raw)
      assertImportBinding(binding, raw, edge, origin)
      const provenance = provenanceOf(edge, binding.imported)
      const earlier = names.get(binding.local)
      if (earlier !== undefined && RANK[earlier.provenance] < RANK[provenance]) continue
      names.set(binding.local, {
        imported: binding.imported,
        source: edge.origins?.get(binding.imported) ?? edge.source,
        provenance,
      })
    }
  }

  return { names, namespaces }
}

function provenanceOf(edge: NamespaceOrigin, name: string): Provenance {
  const origin = edge.origins?.get(name)
  if (origin !== undefined) return isNestjsModule(origin) ? "nestjs" : "foreign"
  return isNestjsModule(edge.source) ? "nestjs" : "unfollowed"
}

export interface ResolvedDecoratorName {
  canonical: string
  confidence: Confidence
}

/** `null` for a decorator the scan traced to a module outside the workspace that is not NestJS's. */
export function resolveDecoratorName(
  decorator: Pick<Decorator, "name" | "qualifier">,
  bindings: ImportedBindings,
): ResolvedDecoratorName | null {
  const { name } = decorator
  if (decorator.qualifier !== undefined) {
    const { head, member } = decoratorReference(decorator)
    const viaNamespace = bindings.namespaces.get(head)
    if (viaNamespace !== undefined) {
      const ranked = viaNamespace.map((edge) => provenanceOf(edge, member))
      return graded(
        name,
        ranked.reduce((best, next) => (RANK[next] < RANK[best] ? next : best)),
      )
    }
    const viaName = bindings.names.get(head)
    if (viaName !== undefined) return graded(name, viaName.provenance)
    return { canonical: name, confidence: "high" }
  }
  const origin = bindings.names.get(name)
  if (origin === undefined) return { canonical: name, confidence: "high" }
  const canonical = origin.imported === DEFAULT_EXPORT_NAME ? name : origin.imported
  return graded(canonical, origin.provenance)
}

function graded(canonical: string, provenance: Provenance): ResolvedDecoratorName | null {
  const confidence = CONFIDENCE[provenance]
  return confidence === null ? null : { canonical, confidence }
}

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

// Frameworks of their own whose decorators share NestJS's names. Any other package outside the
// workspace may wrap NestJS's, as `@nestia/core` does, so it is not refused.
const OTHER_FRAMEWORKS: readonly string[] = [
  "@angular/",
  "@decorators/",
  "@foal/",
  "@inversifyjs/",
  "@midwayjs/",
  "@overnightjs/",
  "@tsed/",
  "@tsoa/",
  "routing-controllers",
  "tsoa",
]

function isOtherFrameworkModule(source: string): boolean {
  return OTHER_FRAMEWORKS.some((entry) =>
    entry.endsWith("/")
      ? source.startsWith(entry)
      : source === entry || source.startsWith(`${entry}/`),
  )
}

/** How far an edge's module is trusted to be NestJS's, best first. */
type Provenance = "nestjs" | "unknown" | "other-framework"

const RANK: Readonly<Record<Provenance, number>> = { nestjs: 0, unknown: 1, "other-framework": 2 }

const CONFIDENCE: Readonly<Record<Provenance, Confidence | null>> = {
  nestjs: "high",
  unknown: "medium",
  "other-framework": null,
}

interface NameOrigin {
  readonly imported: string
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
      if (earlier !== undefined && RANK[earlier.provenance] <= RANK[provenance]) continue
      names.set(binding.local, { imported: binding.imported, provenance })
    }
  }

  return { names, namespaces }
}

// Only a module the scan placed outside the workspace is refused: a specifier as written may be a
// path alias to the project's own files.
function provenanceOf(edge: NamespaceOrigin, name: string): Provenance {
  const origin = edge.origins?.get(name)
  if (origin === undefined) return isNestjsModule(edge.source) ? "nestjs" : "unknown"
  if (isNestjsModule(origin)) return "nestjs"
  return isOtherFrameworkModule(origin) ? "other-framework" : "unknown"
}

export interface ResolvedDecoratorName {
  canonical: string
  confidence: Confidence
}

/** `null` for a decorator the scan traced to another framework's package outside the workspace. */
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

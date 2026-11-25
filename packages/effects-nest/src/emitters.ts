import {
  assertImportEdgeSource,
  assertNamespaceBinding,
  hasMatchingImport,
} from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_NEST_PLUGIN_NAME } from "./constants"

const NEST_EMITTER_MODULES_LIST = ["@nestjs/event-emitter", "eventemitter2"] as const

type NestEmitterModule = (typeof NEST_EMITTER_MODULES_LIST)[number]

const NEST_EMITTER_MODULES: ReadonlySet<NestEmitterModule> = new Set(NEST_EMITTER_MODULES_LIST)

function isNestEmitterModule(source: string): boolean {
  return (NEST_EMITTER_MODULES as ReadonlySet<string>).has(source)
}

export function hasNestEmitterImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath },
    isNestEmitterModule,
  )
}

export const NEST_CQRS_MODULE = "@nestjs/cqrs" as const

function isNestCqrsModule(source: string): boolean {
  return source === NEST_CQRS_MODULE
}

export function hasNestCqrsImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath },
    isNestCqrsModule,
  )
}

export const NEST_EMITTER_CLASS = "EventEmitter2" as const

export function namesNestEmitterClass(
  imports: readonly ImportEdge[],
  typeName: string,
  filePath: string,
): boolean {
  // `eventemitter2` also exports the class as its default; `@nestjs/event-emitter` has no default.
  return namesClass(imports, typeName, filePath, {
    className: NEST_EMITTER_CLASS,
    isModule: isNestEmitterModule,
    exportsAsDefault: (source) => source === "eventemitter2",
  })
}

export const NEST_EVENT_BUS_CLASS = "EventBus" as const

export function namesNestEventBusClass(
  imports: readonly ImportEdge[],
  typeName: string,
  filePath: string,
): boolean {
  return namesClass(imports, typeName, filePath, {
    className: NEST_EVENT_BUS_CLASS,
    isModule: isNestCqrsModule,
    exportsAsDefault: () => false,
  })
}

interface ExportedClass {
  readonly className: string
  readonly isModule: (source: string) => boolean
  readonly exportsAsDefault: (source: string) => boolean
}

function namesClass(
  imports: readonly ImportEdge[],
  typeName: string,
  filePath: string,
  exported: ExportedClass,
): boolean {
  const origin = { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath }
  for (const edge of imports) {
    assertImportEdgeSource(edge, origin)
    if (edge.symbols === "*" && edge.namespaceBinding !== undefined) {
      assertNamespaceBinding(edge.namespaceBinding, edge, origin)
    }
  }
  const { className } = exported
  return imports.some((edge) => {
    if (!exported.isModule(edge.source)) return false
    if (edge.symbols === "*") {
      return (
        edge.namespaceBinding !== undefined && typeName === `${edge.namespaceBinding}.${className}`
      )
    }
    const bound = new Set([
      ...(typeName === className ? [className] : []),
      `${className} as ${typeName}`,
      ...(exported.exportsAsDefault(edge.source) ? [`default as ${typeName}`] : []),
    ])
    return edge.symbols.some((raw) => bound.has(raw))
  })
}

const NEST_EVENT_EMITTER_IDENTIFIERS_LIST = ["eventBus", "EventEmitter2"] as const

export type NestEventEmitterIdentifier = (typeof NEST_EVENT_EMITTER_IDENTIFIERS_LIST)[number]

export const NEST_EVENT_EMITTER_IDENTIFIERS: ReadonlySet<NestEventEmitterIdentifier> = new Set(
  NEST_EVENT_EMITTER_IDENTIFIERS_LIST,
)

export function isNestEventEmitterIdentifier(name: string): name is NestEventEmitterIdentifier {
  return (NEST_EVENT_EMITTER_IDENTIFIERS as ReadonlySet<string>).has(name)
}

/** The name NestJS's CQRS documentation injects its `EventBus` under. */
export const NEST_EVENT_BUS_IDENTIFIER = "eventBus" as const

export const NEST_EMIT_METHOD = "emit" as const

export type NestEmitMethod = typeof NEST_EMIT_METHOD | "emitAsync"

export const NEST_EMIT_METHODS: ReadonlySet<NestEmitMethod> = new Set<NestEmitMethod>([
  NEST_EMIT_METHOD,
  "emitAsync",
])

export function isNestEmitMethod(name: string): name is NestEmitMethod {
  return (NEST_EMIT_METHODS as ReadonlySet<string>).has(name)
}

const NEST_PUBLISH_METHODS_LIST = ["publish", "publishAll"] as const

export type NestPublishMethod = (typeof NEST_PUBLISH_METHODS_LIST)[number]

export const NEST_PUBLISH_METHODS: ReadonlySet<NestPublishMethod> = new Set(
  NEST_PUBLISH_METHODS_LIST,
)

export function isNestPublishMethod(name: string): name is NestPublishMethod {
  return (NEST_PUBLISH_METHODS as ReadonlySet<string>).has(name)
}

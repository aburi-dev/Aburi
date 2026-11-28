import { CoreError } from "@aburi/core"
import type {
  Confidence,
  Decorator,
  FrameworkClassifyContext,
  ImportEdge,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import {
  classifyClassDecorator,
  isMethodBoundaryDecorator,
  methodRoleOf,
  NESTJS_CLASS_DECORATORS,
  NESTJS_DECORATOR_PACKAGES,
  NESTJS_GRAPHQL_OPERATION_DECORATORS,
  NESTJS_HANDLER_DECORATORS,
  NESTJS_HANDLER_HOST_ROLES,
  NESTJS_HTTP_METHOD_DECORATORS,
  NESTJS_METHOD_ROLES,
  NESTJS_PATTERN_DECORATORS,
  NESTJS_TRIGGER_DECORATORS,
  type NestjsMethodRole,
} from "./decorators"
import {
  type ImportedBindings,
  type ResolvedDecoratorName,
  readImportedNames,
  resolveDecoratorName,
} from "./imports"
import { NESTJS_DERIVED_BY_PREFIX } from "./manifest"

/** Shared by HTTP-verb and pattern-style handlers so one predicate finds every entry point. */
const ROUTE_EXT_KIND = "framework:nestjs:route"

export function classifyNestjsSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): SymbolClassification | null {
  if (symbol.kind !== "class" && symbol.kind !== "method") return null
  if (symbol.decorators.length === 0) return null

  const names = importedNamesFor(ctx)
  if (symbol.kind === "class") return classifyClass(symbol, names)
  return classifyMethod(symbol, names)
}

const importedNamesByFile = new WeakMap<readonly ImportEdge[], ImportedBindings>()

function importedNamesFor(ctx: FrameworkClassifyContext): ImportedBindings {
  const cached = importedNamesByFile.get(ctx.imports)
  if (cached !== undefined) return cached
  const names = readImportedNames(ctx.imports, ctx.file.path)
  importedNamesByFile.set(ctx.imports, names)
  return names
}

function classifyClass(
  symbol: SymbolCandidate<OpaqueAstNode>,
  names: ImportedBindings,
): SymbolClassification | null {
  const boundaries: Record<string, true> = {}
  const handlerKeys: string[] = []
  let hostsHandlers = false
  let winner: { extKind: string; role: string } | null = null
  let confidence: Confidence = "high"

  for (const decorator of symbol.decorators) {
    const resolved = resolveNestjsDecorator(decorator, symbol.id, names)
    if (resolved === null) continue
    if (NESTJS_HANDLER_DECORATORS.has(resolved.canonical)) {
      handlerKeys.push(boundaryKey(decorator))
      continue
    }
    const hit = classifyClassDecorator(resolved.canonical)
    if (hit === undefined) continue
    boundaries[boundaryKey(decorator)] = true
    if (NESTJS_HANDLER_HOST_ROLES.has(hit.role)) hostsHandlers = true
    if (winner !== null) continue
    winner = hit
    confidence = resolved.confidence
  }
  if (winner === null) return null
  if (hostsHandlers) for (const key of handlerKeys) boundaries[key] = true

  return {
    extKind: winner.extKind,
    decoratorBoundaries: boundaries,
    // The semantic role, not the identifier: `@Injectable` means "provider".
    derivedBy: `${NESTJS_DERIVED_BY_PREFIX}:${winner.role}`,
    ...confidenceOverride(confidence),
  }
}

function classifyMethod(
  symbol: SymbolCandidate<OpaqueAstNode>,
  names: ImportedBindings,
): SymbolClassification | null {
  const boundaries: Record<string, true> = {}
  const firstOfRole = new Map<NestjsMethodRole, ResolvedDecoratorName>()

  for (const decorator of symbol.decorators) {
    const resolved = resolveNestjsDecorator(decorator, symbol.id, names)
    if (resolved === null) continue
    const role = methodRoleOf(resolved.canonical)
    if (role === null) continue
    boundaries[boundaryKey(decorator)] = true
    if (!firstOfRole.has(role)) firstOfRole.set(role, resolved)
  }

  for (const role of NESTJS_METHOD_ROLES) {
    const winner = firstOfRole.get(role)
    if (winner === undefined) continue
    return {
      ...(role === "route" ? { extKind: ROUTE_EXT_KIND } : {}),
      decoratorBoundaries: boundaries,
      derivedBy: `${NESTJS_DERIVED_BY_PREFIX}:${role}:${winner.canonical}`,
      ...confidenceOverride(winner.confidence),
    }
  }
  return null
}

/** `null` for a decorator the scan did not trace to the package that gives it this meaning. */
function resolveNestjsDecorator(
  decorator: Decorator,
  symbolId: string,
  names: ImportedBindings,
): ResolvedDecoratorName | null {
  assertDecoratorName(decorator.name, symbolId)
  assertDecoratorQualifier(decorator.qualifier, decorator.name, symbolId)
  const resolved = resolveDecoratorName(decorator, names)
  if (resolved === null) return null
  const required = NESTJS_DECORATOR_PACKAGES.get(resolved.canonical)
  return required === undefined || resolved.nestjsPackage === required ? resolved : null
}

/** `high` is the documented meaning of an omitted `confidence`, so it is spread as nothing. */
function confidenceOverride(confidence: Confidence): { confidence?: Confidence } {
  return confidence === "high" ? {} : { confidence }
}

function boundaryKey(decorator: Decorator): string {
  const { qualifier } = decorator
  return qualifier === undefined ? decorator.name : `${qualifier}.${decorator.name}`
}

/** An empty decorator name is a language-plugin grammar regression; fail fast rather than let it fall through `Map.get("")`. */
function assertDecoratorName(name: string, symbolId: string): void {
  if (name.length > 0) return
  throw new CoreError(
    `Empty decorator name on Symbol "${symbolId}"; the upstream language plugin produced an unexpected grammar shape and this classifier refuses to silently skip it`,
    { code: "anonymous-symbol-id-attempted", value: symbolId },
  )
}

function assertDecoratorQualifier(
  qualifier: string | undefined,
  name: string,
  symbolId: string,
): void {
  if (qualifier === undefined) return
  if (qualifier.length > 0 && !qualifier.startsWith(".")) return
  throw new CoreError(
    `Decorator "${name}" on Symbol "${symbolId}" carries an unusable qualifier "${qualifier}"; the upstream language plugin produced an unexpected grammar shape and this classifier refuses to silently skip it`,
    { code: "anonymous-symbol-id-attempted", value: symbolId },
  )
}

export {
  classifyClassDecorator,
  isMethodBoundaryDecorator,
  NESTJS_CLASS_DECORATORS,
  NESTJS_DECORATOR_PACKAGES,
  NESTJS_GRAPHQL_OPERATION_DECORATORS,
  NESTJS_HANDLER_DECORATORS,
  NESTJS_HANDLER_HOST_ROLES,
  NESTJS_HTTP_METHOD_DECORATORS,
  NESTJS_PATTERN_DECORATORS,
  NESTJS_TRIGGER_DECORATORS,
}

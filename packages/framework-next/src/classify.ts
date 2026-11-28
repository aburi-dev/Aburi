import { DEFAULT_EXPORT_NAME, exportNames } from "@aburi/core"
import {
  CALL_ARGUMENT_FUNCTION_DERIVED_BY,
  EXPORT_DEFAULT_DERIVED_BY,
  type ExtractionContext,
  type FrameworkClassifyContext,
  type OpaqueAstNode,
  type SymbolCandidate,
  type SymbolClassification,
  type SymbolKind,
} from "@aburi/types"
import {
  type AppRouterFile,
  type MiddlewareFile,
  recognizeAppRouterFile,
  recognizeMiddlewareFile,
} from "./app-router"
import { detectModuleDirective, type ModuleDirective } from "./directives"
import { NEXT_DERIVED_BY_PREFIX } from "./manifest"

export type NextHttpVerb = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD"

export const NEXT_ROUTE_HTTP_VERBS: ReadonlySet<NextHttpVerb> = new Set<NextHttpVerb>([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "HEAD",
])

export function isNextHttpVerb(name: string): name is NextHttpVerb {
  return (NEXT_ROUTE_HTTP_VERBS as ReadonlySet<string>).has(name)
}
export function classifyNextSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): SymbolClassification | null {
  const root = ctx.component?.root ?? "."
  const file = recognizeAppRouterFile(symbol.source.file, root)
  if (file !== null) {
    if (file.role === "route") return classifyRouteSymbol(symbol, ctx)
    return classifyComponentSymbol(symbol, file, ctx)
  }
  const middleware = recognizeMiddlewareFile(symbol.source.file, root)
  if (middleware !== null) return classifyMiddlewareSymbol(symbol, middleware)
  return classifyServerAction(symbol, ctx)
}

/** A handler the language plugin cannot see to be a function (a destructuring, a call's result) is a `const`; Next calls it all the same. */
const ROUTE_HANDLER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["function", "const"])

function classifyRouteSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): SymbolClassification | null {
  if (!ROUTE_HANDLER_KINDS.has(symbol.kind)) return null
  const verbs = exportNames(symbol).filter(isNextHttpVerb)
  if (verbs.length === 0) return null
  return withDirective(
    {
      extKind: "framework:next:route",
      derivedBy: verbs.map((verb) => `${NEXT_DERIVED_BY_PREFIX}:route:${verb}`).join(";"),
    },
    ctx,
  )
}

function classifyComponentSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  file: AppRouterFile,
  ctx: ExtractionContext,
): SymbolClassification | null {
  if (!isComponentValue(symbol)) return null
  if (!symbol.derivedBy.includes(EXPORT_DEFAULT_DERIVED_BY)) return null
  return withDirective(
    {
      extKind: `framework:next:${file.role}`,
      derivedBy: `${NEXT_DERIVED_BY_PREFIX}:${file.role}`,
    },
    ctx,
  )
}

function classifyMiddlewareSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  file: MiddlewareFile,
): SymbolClassification | null {
  if (!ROUTE_HANDLER_KINDS.has(symbol.kind)) return null
  const names = exportNames(symbol)
  if (!names.includes(file.export) && !names.includes(DEFAULT_EXPORT_NAME)) return null
  return {
    extKind: "framework:next:middleware",
    derivedBy: `${NEXT_DERIVED_BY_PREFIX}:${file.export}`,
  }
}

/** Every export of a `"use server"` module is callable from the client, wherever the module is. */
function classifyServerAction(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): SymbolClassification | null {
  if (!isServerFunction(symbol) || exportNames(symbol).length === 0) return null
  if (detectModuleDirective(ctx.file.content) !== "server") return null
  return {
    extKind: "framework:next:server-action",
    derivedBy: `${NEXT_DERIVED_BY_PREFIX}:server-action`,
  }
}

/** Next.js refuses a `"use server"` module's export that is not an async function at build time. */
function isServerFunction(symbol: SymbolCandidate<OpaqueAstNode>): boolean {
  if (symbol.kind === "function") return symbol.signature?.async === true
  return symbol.kind === "const" && symbol.derivedBy.includes(CALL_ARGUMENT_FUNCTION_DERIVED_BY)
}

/** `withAuth(function Page() {…})` is a `const` the language plugin cannot see to be a function; the function it is handed is the evidence. */
function isComponentValue(symbol: SymbolCandidate<OpaqueAstNode>): boolean {
  if (symbol.kind === "function") return true
  return symbol.kind === "const" && symbol.derivedBy.includes(CALL_ARGUMENT_FUNCTION_DERIVED_BY)
}

function withDirective(base: SymbolClassification, ctx: ExtractionContext): SymbolClassification {
  const directive = detectModuleDirective(ctx.file.content)
  if (directive === null) return base
  return {
    ...base,
    derivedBy: `${base.derivedBy};${NEXT_DERIVED_BY_PREFIX}:${directiveTag(directive)}`,
  }
}

type DirectiveTag = "client-component" | "server-action"

function directiveTag(directive: ModuleDirective): DirectiveTag {
  return directive === "client" ? "client-component" : "server-action"
}

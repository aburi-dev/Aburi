import {
  asSyntaxNode,
  calleeName,
  referenceCalls,
  type SyntaxNode,
  unwrapValue,
  writtenChildren,
} from "@aburi/core"
import type {
  Confidence,
  FrameworkCall,
  FrameworkClassifyContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import type { ExpressExtKind } from "./ext-kinds"
import { EXPRESS_DERIVED_BY_PREFIX } from "./ext-kinds"
import { hasExpressImport } from "./imports"
import { analyzeUseArguments, EXPRESS_MIDDLEWARE_METHOD, type UseArgumentShape } from "./middleware"
import {
  type Registration,
  registersRoute,
  registrationMiddleware,
  registrationsOf,
} from "./registration-middleware"
import { extractRouterCall, moduleBindings } from "./router"
import { hasRouteArguments, isRouteMethod } from "./routes"

/** `extKind` narrowed to the plugin's own union so a typo fails to compile. */
interface ExpressClassification {
  extKind: ExpressExtKind
  derivedBy: string
  confidence: Confidence
  middleware?: readonly string[]
  calls?: readonly FrameworkCall[]
}

export function classifyExpressSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): SymbolClassification | null {
  const result = classifyBySymbolKind(symbol, ctx)
  if (result === null) return null
  const middleware = result.middleware ?? []
  const calls = result.calls ?? []
  return {
    extKind: result.extKind,
    derivedBy: result.derivedBy,
    confidence: result.confidence,
    ...(middleware.length > 0 ? { middleware } : {}),
    ...(calls.length > 0 ? { calls } : {}),
  }
}

function classifyBySymbolKind(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): ExpressClassification | null {
  if (symbol.kind === "const") return classifyConstSymbol(symbol, ctx)
  if (symbol.kind === "call") return classifyCallSymbol(symbol, ctx)
  return null
}

function classifyConstSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): ExpressClassification | null {
  const routerCall = extractRouterCall(symbol.fullNode, symbol.name)
  if (routerCall === null) return null
  // An `express` import is what separates "definitely Express" (high) from "matches the pattern" (medium).
  const confidence: Confidence = hasExpressImport(ctx) ? "high" : "medium"
  return {
    extKind: "framework:express:router",
    derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:router:${routerCall.name}`,
    confidence,
  }
}

function classifyCallSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): ExpressClassification | null {
  const call = asSyntaxNode(symbol.fullNode)
  if (call === null) return null
  const registrations = registrationsOf(call)
  const registration = classifyRegistration(call, registrations, symbol, ctx)
  if (registration === null) return null
  // Express runs every handler a registration names, so each is a call the Symbol makes and the
  // handler's effects are the route's.
  const handlers = registrations.flatMap((step) => step.handlers)
  return {
    ...registration,
    middleware: registrationMiddleware(registrations),
    calls: referenceCalls(handlers),
  }
}

function classifyRegistration(
  call: SyntaxNode,
  registrations: readonly Registration[],
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): ExpressClassification | null {
  const callee = calleeName(call)
  if (callee === null) return null
  const importAnchored = hasExpressImport(ctx)

  if (isRouteMethod(callee.leaf) && hasRouteArguments(call)) {
    // The language plugin names the Symbol after the chain's outermost call, so that method leads,
    // agreeing with the `call-statement:` entry.
    const methods = new Set([
      callee.name,
      ...registrations.filter(registersRoute).map((route) => route.callee.name),
    ])
    return {
      extKind: "framework:express:route",
      derivedBy: [...methods].map((name) => `${EXPRESS_DERIVED_BY_PREFIX}:route:${name}`).join(";"),
      confidence: importAnchored ? "high" : "medium",
    }
  }

  if (callee.leaf === EXPRESS_MIDDLEWARE_METHOD) {
    return classifyUseCall(callee.name, call, symbol, importAnchored)
  }

  return null
}

function classifyUseCall(
  name: string,
  call: SyntaxNode,
  symbol: SymbolCandidate<OpaqueAstNode>,
  importAnchored: boolean,
): ExpressClassification | null {
  const shape = analyzeUseArguments(symbol.fullNode)
  if (shape === null) return null

  if (shape.hasErrorHandler) {
    return {
      extKind: "framework:express:error-middleware",
      derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:error-middleware:${name};arity-4`,
      confidence: importAnchored ? "high" : "medium",
    }
  }

  const mounted = isMountShape(shape) ? mountedName(call) : null
  const bindings = mounted === null ? null : moduleBindings(call)
  if (mounted !== null && bindings !== null && !bindings.functions.has(mounted)) {
    // A name the module does not bind to a Router may be any middleware: imported, it is unread.
    const declaredRouter = bindings.routers.has(mounted)
    return {
      extKind: "framework:express:mount",
      derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:mount:${name};router-identifier`,
      confidence: declaredRouter && importAnchored ? "high" : "medium",
    }
  }

  if (shape.hasRegularHandler || shape.hasIdentifierArg || shape.hasCallArg) {
    const arity = shape.hasRegularHandler
      ? "arity-3"
      : shape.hasIdentifierArg
        ? "identifier-arg"
        : "factory-call"
    // A name or a factory's result cannot be arity-checked here, so it is capped at medium.
    const confidence: Confidence = shape.hasRegularHandler && importAnchored ? "high" : "medium"
    return {
      extKind: "framework:express:middleware",
      derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:middleware:${name};${arity}`,
      confidence,
    }
  }

  return null
}

function mountedName(call: SyntaxNode): string | null {
  const second = writtenChildren(call.childForFieldName("arguments"))[1]
  return second === undefined ? null : unwrapValue(second).text
}

function isMountShape(shape: UseArgumentShape): boolean {
  return (
    shape.argCount === 2 &&
    shape.firstArgIsPathLiteral &&
    shape.secondArgIsIdentifier &&
    !shape.hasRegularHandler &&
    !shape.hasErrorHandler
  )
}

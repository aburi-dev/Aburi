import {
  type CalleeName,
  calleeName,
  chainCalls,
  middlewareNames,
  type SyntaxNode,
  unwrapValue,
  writtenChildren,
} from "@aburi/core"
import { EXPRESS_MIDDLEWARE_METHOD } from "./middleware"
import {
  handlerArguments,
  hasRouteArguments,
  hasRouteCallUpTheChain,
  isRouteMethod,
} from "./routes"

export interface Registration {
  readonly call: SyntaxNode
  readonly callee: CalleeName
  /** What it hands Express to run, flattened as Express flattens it, the path left out. */
  readonly handlers: readonly SyntaxNode[]
}

/** The `use` and route registrations a statement's chain makes, in the order it makes them. */
export function registrationsOf(call: SyntaxNode): Registration[] {
  return chainCalls(call)
    .toReversed()
    .flatMap((registration) => {
      const callee = calleeName(registration)
      if (callee?.leaf === EXPRESS_MIDDLEWARE_METHOD) {
        return [{ call: registration, callee, handlers: useArguments(registration) }]
      }
      if (callee === null || !isRouteRegistration(registration)) return []
      const handlers = handlerArguments(registration).flatMap(flattened)
      return [{ call: registration, callee, handlers }]
    })
}

export function registersRoute({ callee }: Registration): boolean {
  return callee.leaf !== EXPRESS_MIDDLEWARE_METHOD
}

export function registrationMiddleware(registrations: readonly Registration[]): string[] {
  const routes = registrations.filter(registersRoute)
  // One Symbol holds every route a statement registers, so a bare name could not say which method
  // a guard moved to. A `.route()` chain qualifies even one, so its names hold as methods come and go.
  const qualified = routes.length > 1 || routes.some((route) => hasRouteCallUpTheChain(route.call))
  return registrations.flatMap(({ callee, handlers }, index) => {
    if (callee.leaf === EXPRESS_MIDDLEWARE_METHOD) return middlewareNames(handlers)
    const guardsLaterRoutes =
      callee.leaf === ALL_METHODS && registrations.slice(index + 1).some(registersRoute)
    const names = middlewareNames(guardsLaterRoutes ? handlers : handlers.slice(0, -1))
    if (!qualified) return names
    if (names.length === 0) return [`${callee.leaf}:`]
    return names.map((name) => `${callee.leaf}:${name}`)
  })
}

// An `.all(...)` ahead of other methods in one chain runs first for each of them, so every
// handler it takes passes the request on rather than answering it.
const ALL_METHODS = "all"

function isRouteRegistration(call: SyntaxNode): boolean {
  const leaf = calleeName(call)?.leaf
  return leaf !== undefined && isRouteMethod(leaf) && hasRouteArguments(call)
}

function useArguments(call: SyntaxNode): SyntaxNode[] {
  const args = writtenChildren(call.childForFieldName("arguments"))
  const [first] = args
  return (first !== undefined && isUsePath(first) ? args.slice(1) : args).flatMap(flattened)
}

const USE_PATH_TYPES: ReadonlySet<string> = new Set(["string", "template_string", "regex"])

// Express reads an array's first entry, at any depth, to tell a path from a handler, and an
// empty array is a path.
function isUsePath(node: SyntaxNode): boolean {
  const value = unwrapValue(node)
  if (value.type !== "array") return USE_PATH_TYPES.has(value.type)
  const [first] = writtenChildren(value)
  return first === undefined || isUsePath(first)
}

/** Express flattens arrays of handlers, at any depth and through a spread of one. */
function flattened(node: SyntaxNode): SyntaxNode[] {
  const value = unwrapValue(node)
  if (value.type === "array") return writtenChildren(value).flatMap(flattened)
  if (value.type === "spread_element") {
    const [spread] = writtenChildren(value)
    if (spread !== undefined && unwrapValue(spread).type === "array") return flattened(spread)
  }
  return [value]
}

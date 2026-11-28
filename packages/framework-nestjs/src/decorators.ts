export const NESTJS_CLASS_DECORATORS: ReadonlyMap<string, { extKind: string; role: string }> =
  new Map([
    ["Module", { extKind: "framework:nestjs:module", role: "module" }],
    ["Controller", { extKind: "framework:nestjs:controller", role: "controller" }],
    ["Injectable", { extKind: "framework:nestjs:provider", role: "provider" }],
    ["Catch", { extKind: "framework:nestjs:filter", role: "filter" }],
    ["Resolver", { extKind: "framework:nestjs:resolver", role: "resolver" }],
    ["WebSocketGateway", { extKind: "framework:nestjs:gateway", role: "gateway" }],
  ])

/** The class roles whose handlers NestJS runs a class-level guard, interceptor, pipe or filter around. */
export const NESTJS_HANDLER_HOST_ROLES: ReadonlySet<string> = new Set([
  "controller",
  "resolver",
  "gateway",
])

export const NESTJS_HTTP_METHOD_DECORATORS: ReadonlySet<string> = new Set([
  "Get",
  "Post",
  "Put",
  "Delete",
  "Patch",
  "Options",
  "Head",
  "Search",
  "All",
  "Sse",
])

export const NESTJS_HANDLER_DECORATORS: ReadonlySet<string> = new Set([
  "UseGuards",
  "UseInterceptors",
  "UsePipes",
  "UseFilters",
])

export const NESTJS_PATTERN_DECORATORS: ReadonlySet<string> = new Set([
  "MessagePattern",
  "EventPattern",
  "SubscribeMessage",
  "GrpcMethod",
  "GrpcStreamMethod",
  "GrpcStreamCall",
])

export const NESTJS_GRAPHQL_OPERATION_DECORATORS: ReadonlySet<string> = new Set([
  "Query",
  "Mutation",
  "Subscription",
  "ResolveField",
  "ResolveReference",
])

/** Methods NestJS calls on a schedule or an in-process event rather than a request. */
export const NESTJS_TRIGGER_DECORATORS: ReadonlySet<string> = new Set([
  "Cron",
  "Interval",
  "Timeout",
  "OnEvent",
])

// Other libraries give these names a meaning of their own (`Query` is also `@nestjs/common`'s
// parameter decorator, `Resolver` is type-graphql's, `Timeout` is everyone's), so a written name
// says nothing until the scan traces it to the one package that defines this one.
export const NESTJS_DECORATOR_PACKAGES: ReadonlyMap<string, string> = new Map([
  ["Resolver", "@nestjs/graphql"],
  ["Query", "@nestjs/graphql"],
  ["Mutation", "@nestjs/graphql"],
  ["Subscription", "@nestjs/graphql"],
  ["ResolveField", "@nestjs/graphql"],
  ["ResolveReference", "@nestjs/graphql"],
  ["Cron", "@nestjs/schedule"],
  ["Interval", "@nestjs/schedule"],
  ["Timeout", "@nestjs/schedule"],
  ["OnEvent", "@nestjs/event-emitter"],
])

export type NestjsMethodRole = "route" | "trigger" | "handler"

/** The order a method takes its role in: a route says what calls it, a trigger when, a handler only what runs around it. */
export const NESTJS_METHOD_ROLES: readonly NestjsMethodRole[] = ["route", "trigger", "handler"]

export function methodRoleOf(name: string): NestjsMethodRole | null {
  if (
    NESTJS_HTTP_METHOD_DECORATORS.has(name) ||
    NESTJS_PATTERN_DECORATORS.has(name) ||
    NESTJS_GRAPHQL_OPERATION_DECORATORS.has(name)
  ) {
    return "route"
  }
  if (NESTJS_TRIGGER_DECORATORS.has(name)) return "trigger"
  if (NESTJS_HANDLER_DECORATORS.has(name)) return "handler"
  return null
}

export function isMethodBoundaryDecorator(name: string): boolean {
  return methodRoleOf(name) !== null
}

/** Exported for symmetry with `isMethodBoundaryDecorator`. */
export function classifyClassDecorator(
  name: string,
): { extKind: string; role: string } | undefined {
  return NESTJS_CLASS_DECORATORS.get(name)
}

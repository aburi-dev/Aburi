import {
  asSyntaxNode,
  calleeName,
  chainCalls,
  declaratorValue,
  decodeStringLiteral,
  lastQnameSegment,
  middlewareNames,
  referenceCalls,
  type SyntaxNode,
  unwrapValue,
  writtenChildren,
} from "@aburi/core"
import {
  COMPUTED_TARGET_SEGMENT,
  type FrameworkCall,
  type FrameworkClassifyContext,
  type OpaqueAstNode,
  type SymbolCandidate,
  type SymbolClassification,
} from "@aburi/types"
import { type Chain, readChain } from "./chain"
import { TRPC_DERIVED_BY_PREFIX, type TrpcExtKind } from "./ext-kinds"
import { hasTrpcServerImport } from "./imports"

type TrpcRole = TrpcExtKind extends `${typeof TRPC_DERIVED_BY_PREFIX}:${infer Role}` ? Role : never

const ROUTER_FACTORIES: ReadonlySet<string> = new Set(["router", "createTRPCRouter"])
const PROCEDURE_TERMINALS: ReadonlySet<string> = new Set(["query", "mutation", "subscription"])
const BUILDER_STEPS: ReadonlySet<string> = new Set(["use", "input", "output", "meta", "concat"])
// `concat` hands over another builder, whose middleware runs where the call is written.
const MIDDLEWARE_STEPS: ReadonlySet<string> = new Set(["use", "concat"])
const BUILDS_A_PROCEDURE: ReadonlySet<TrpcRole> = new Set(["procedure", "base-procedure"])
const RESOLVER_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
  "identifier",
  "member_expression",
  "call_expression",
])
// tRPC's documentation and create-t3-app name a base procedure `procedure` or `…Procedure`.
const PROCEDURE_NAME = /(^p|P)rocedure$/

export function classifyTrpcSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): SymbolClassification | null {
  if (symbol.kind !== "const") return null
  const statement = asSyntaxNode(symbol.fullNode)
  if (statement === null) return null
  // `lastQnameSegment` throws on a broken qname; that is a language-plugin bug not to swallow.
  const initializer = declaratorValue(statement, lastQnameSegment(symbol.name))
  const chain = initializer === null ? null : readChain(initializer)
  const importsTrpc = hasTrpcServerImport(ctx.imports)
  const role = chain === null ? null : roleOf(chain, importsTrpc)
  if (chain === null || role === null) return null
  const { middleware, calls } = BUILDS_A_PROCEDURE.has(role)
    ? builtOn(chain)
    : role === "router"
      ? servedBy(chain, importsTrpc)
      : { middleware: [], calls: [] }
  return {
    extKind: `${TRPC_DERIVED_BY_PREFIX}:${role}` satisfies TrpcExtKind,
    derivedBy: `${TRPC_DERIVED_BY_PREFIX}:${role}:${chain.name}`,
    // Most of these names are tRPC's conventions rather than its exports, so only the import
    // makes them tRPC's.
    confidence: importsTrpc ? "high" : "medium",
    ...(middleware.length > 0 ? { middleware } : {}),
    ...(calls.length > 0 ? { calls } : {}),
  }
}

interface BuiltOn {
  readonly middleware: readonly string[]
  readonly calls: readonly FrameworkCall[]
}

// A base procedure the chain starts from runs its middleware first, as the builder a `concat`
// joins runs its own where the call is written.
function builtOn(chain: Chain): BuiltOn {
  const onBase = !readsInstanceProcedure(chain)
  const handlers =
    chain.call === null
      ? []
      : chainCalls(chain.call)
          .toReversed()
          .filter((step) => MIDDLEWARE_STEPS.has(calleeName(step)?.leaf ?? ""))
          .flatMap(argumentsOf)
  return {
    middleware: [...(onBase ? [chain.root] : []), ...middlewareNames(handlers)],
    calls: referenceCalls(
      onBase && chain.rootReference !== null ? [chain.rootReference, ...handlers] : handlers,
    ),
  }
}

/** A procedure a router's object writes in place, and the path a client calls it by. */
interface Served {
  readonly path: string
  readonly built: BuiltOn
}

// Such a procedure is no Symbol, so the router names what each is built on under its path, two on
// one base staying apart. tRPC looks a procedure up by its path, so key order is not named.
function servedBy(router: Chain, importsTrpc: boolean): BuiltOn {
  const served = routerProcedures(router, importsTrpc, "").toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  return {
    middleware: served.flatMap(({ path, built }) =>
      built.middleware.map((name) => `${path}:${name}`),
    ),
    calls: served.flatMap(({ built }) => built.calls),
  }
}

function routerProcedures(router: Chain, importsTrpc: boolean, prefix: string): Served[] {
  const args = router.call === null ? [] : argumentsOf(router.call)
  if (router.leaf !== "mergeRouters") {
    const [procedures] = args
    return procedures === undefined
      ? []
      : objectProcedures(unwrapValue(procedures), importsTrpc, prefix)
  }
  // A merged router's procedures are served at the paths it gives them.
  return args.flatMap((merged) => {
    const chain = readChain(unwrapValue(merged))
    return chain !== null && roleOf(chain, importsTrpc) === "router"
      ? routerProcedures(chain, importsTrpc, prefix)
      : []
  })
}

function objectProcedures(object: SyntaxNode, importsTrpc: boolean, prefix: string): Served[] {
  if (object.type !== "object") return []
  return writtenChildren(object).flatMap((entry) => {
    const value = entry.type === "pair" ? entry.childForFieldName("value") : null
    if (value === null) return []
    const path = `${prefix}${propertyKey(entry)}`
    const written = unwrapValue(value)
    // tRPC reads a plain object as a router written in place.
    if (written.type === "object") return objectProcedures(written, importsTrpc, `${path}.`)
    const chain = readChain(written)
    const role = chain === null ? null : roleOf(chain, importsTrpc)
    if (chain === null || role === null) return []
    if (role === "router") return routerProcedures(chain, importsTrpc, `${path}.`)
    return role === "procedure" ? [{ path, built: builtOn(chain) }] : []
  })
}

// A call target names what it cannot read `<computed>`, and so does a key.
function propertyKey(pair: SyntaxNode): string {
  const key = pair.childForFieldName("key")
  return (key === null ? null : keyName(key)) ?? COMPUTED_TARGET_SEGMENT
}

function keyName(key: SyntaxNode): string | null {
  switch (key.type) {
    case "property_identifier":
      return key.text
    case "number":
      return numberKeyName(key.text)
    case "string":
    case "template_string": {
      const { value, whole } = decodeStringLiteral(key)
      return whole ? value : null
    }
    case "computed_property_name": {
      const [expression] = writtenChildren(key)
      return expression === undefined ? null : keyName(unwrapValue(expression))
    }
    default:
      return null
  }
}

// A number key names its property by its value, so `0x10`, `1_6` and `16` are one key.
function numberKeyName(text: string): string {
  const digits = text.replaceAll("_", "")
  return BIGINT_LITERAL.test(digits)
    ? BigInt(digits.slice(0, -1)).toString()
    : String(Number(digits))
}

const BIGINT_LITERAL = /^(?:0[box][\da-f]+|\d+)n$/i

function roleOf(chain: Chain, importsTrpc: boolean): TrpcRole | null {
  const { call, leaf } = chain
  // `procedure` is a domain word as well (`form.procedure`), and a bare read says nothing more,
  // so it is taken only off a plain name in the file that creates tRPC's instance.
  if (call === null) {
    const instanceRead =
      leaf === "procedure" && chain.path.length === 0 && isInstanceName(chain.root)
    return instanceRead && importsTrpc ? "base-procedure" : null
  }
  const args = argumentsOf(call)
  if (leaf === "create") return chain.root === "initTRPC" ? "instance" : null
  if (ROUTER_FACTORIES.has(leaf)) {
    const [only, ...rest] = args
    return only !== undefined && rest.length === 0 && unwrapValue(only).type === "object"
      ? "router"
      : null
  }
  if (leaf === "mergeRouters") return args.length > 0 ? "router" : null
  if (leaf === "middleware") return isResolver(args) ? "middleware" : null
  if (!buildsOnProcedure(chain)) return null
  if (PROCEDURE_TERMINALS.has(leaf)) return isResolver(args) ? "procedure" : null
  return BUILDER_STEPS.has(leaf) ? "base-procedure" : null
}

function buildsOnProcedure(chain: Chain): boolean {
  return readsInstanceProcedure(chain) || PROCEDURE_NAME.test(chain.root)
}

function readsInstanceProcedure(chain: Chain): boolean {
  const read = chain.call === null ? chain.leaf : chain.path.at(-1)
  return read === "procedure" && isInstanceName(chain.root)
}

// tRPC's instance is held under a plain name (`t`), never `this` or an expression.
function isInstanceName(root: string): boolean {
  return root !== "this" && root !== COMPUTED_TARGET_SEGMENT
}

// A tagged template's `arguments` is the template itself, which hands over no resolver.
function argumentsOf(call: SyntaxNode): SyntaxNode[] {
  const list = call.childForFieldName("arguments")
  return list?.type === "arguments" ? writtenChildren(list) : []
}

function isResolver(args: readonly SyntaxNode[]): boolean {
  const [only, ...rest] = args
  return only !== undefined && rest.length === 0 && RESOLVER_TYPES.has(unwrapValue(only).type)
}

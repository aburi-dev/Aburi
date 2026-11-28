import {
  asSyntaxNode,
  type CalleeName,
  calleeName,
  declaratorValue,
  lastQnameSegment,
  type SyntaxNode,
  unwrapValue,
} from "@aburi/core"

export const EXPRESS_ROUTER_FACTORIES: ReadonlySet<string> = new Set(["Router"])

export type RouterCall = CalleeName

export function extractRouterCall(fullNode: unknown, name: string): RouterCall | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  // `lastQnameSegment` throws on a broken qname; that is a language-plugin bug not to swallow.
  const initializer = declaratorValue(node, lastQnameSegment(name))
  if (initializer === null || initializer.type !== "call_expression") return null
  const callee = calleeName(initializer)
  return callee !== null && EXPRESS_ROUTER_FACTORIES.has(callee.leaf) ? callee : null
}

/** What a module declares at its top level under a name a mount could hand Express. */
export interface ModuleBindings {
  /** Bound to a Router factory's result, as `const api = express.Router()` is. */
  readonly routers: ReadonlySet<string>
  /** Declared as a function, which a mount cannot be handed as a Router. */
  readonly functions: ReadonlySet<string>
}

const FUNCTION_VALUE_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression"])

/** The top-level bindings of the module `node` is written in. */
export function moduleBindings(node: SyntaxNode): ModuleBindings {
  const routers = new Set<string>()
  const functions = new Set<string>()
  for (const statement of moduleRoot(node).namedChildren) {
    const declaration =
      statement?.type === "export_statement"
        ? statement.childForFieldName("declaration")
        : statement
    if (declaration === null || declaration === undefined) continue
    if (declaration.type === "function_declaration") {
      const name = declaration.childForFieldName("name")
      if (name !== null) functions.add(name.text)
      continue
    }
    if (declaration.type !== "lexical_declaration" && declaration.type !== "variable_declaration") {
      continue
    }
    for (const declarator of declaration.namedChildren) {
      if (declarator?.type !== "variable_declarator") continue
      const name = declarator.childForFieldName("name")
      const written = declarator.childForFieldName("value")
      if (name?.type !== "identifier" || written === null) continue
      const value = unwrapValue(written)
      if (FUNCTION_VALUE_TYPES.has(value.type)) functions.add(name.text)
      else if (value.type === "call_expression") {
        const callee = calleeName(value)
        if (callee !== null && EXPRESS_ROUTER_FACTORIES.has(callee.leaf)) routers.add(name.text)
      }
    }
  }
  return { routers, functions }
}

function moduleRoot(node: SyntaxNode): SyntaxNode {
  let cursor = node
  for (;;) {
    const parent = "parent" in cursor ? asSyntaxNode(cursor.parent) : null
    if (parent === null) return cursor
    cursor = parent
  }
}

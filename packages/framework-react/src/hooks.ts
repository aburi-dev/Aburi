import { asSyntaxNode, calleeName, receiverChain, type SyntaxNode } from "@aburi/core"
import { isPascalCase } from "./components"

/** The rule `eslint-plugin-react-hooks` enforces. */
export function matchesHookNaming(leaf: string): boolean {
  return /^use[A-Z]/.test(leaf)
}

export function bodyCallsAnotherHook(body: unknown): boolean {
  const node = asSyntaxNode(body)
  return node !== null && callsHook(node)
}

function callsHook(node: SyntaxNode): boolean {
  if (node.type === "call_expression" && isHookCall(node)) return true
  return node.namedChildren.some((child) => child !== null && callsHook(child))
}

// `eslint-plugin-react-hooks` takes a hook called by its name or on a PascalCase namespace
// (`React.useState()`), and a client's procedure path holds hooks too
// (`trpc.viewer.me.useQuery()`), but a lowercase object's own method (`vi.useFakeTimers()`) is
// that object's.
function isHookCall(call: SyntaxNode): boolean {
  const callee = calleeName(call)
  if (callee === null || !matchesHookNaming(callee.leaf)) return false
  if (callee.name === callee.leaf || isPascalCase(callee.name)) return true
  const object = call.childForFieldName("function")?.childForFieldName("object")
  return object != null && receiverChain(object).path.length > 0
}

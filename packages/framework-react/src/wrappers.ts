import {
  asSyntaxNode,
  type CalleeName,
  calleeName,
  declaratorValue,
  lastQnameSegment,
  type SyntaxNode,
} from "@aburi/core"

/** Bare identifiers only: `React.<name>` callees are matched by leaf. */
export const REACT_CONTEXT_FACTORIES: ReadonlySet<string> = new Set(["createContext"])
export const REACT_FORWARD_REF_FACTORIES: ReadonlySet<string> = new Set(["forwardRef"])
export const REACT_MEMO_FACTORIES: ReadonlySet<string> = new Set(["memo"])

export type WrapperCall = CalleeName

export function extractWrapperCall(fullNode: unknown, name: string): WrapperCall | null {
  const call = wrapperCallNode(fullNode, name)
  return call === null ? null : calleeName(call)
}

/** The call a const's own initializer is, which `extractWrapperCall` names. */
export function wrapperCallNode(fullNode: unknown, name: string): SyntaxNode | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  // `lastQnameSegment` throws on a broken qname; that is a language-plugin bug not to swallow.
  const call = declaratorValue(node, lastQnameSegment(name))
  return call === null || call.type !== "call_expression" ? null : call
}

export function isContextCall(call: WrapperCall | null): boolean {
  return call !== null && REACT_CONTEXT_FACTORIES.has(call.leaf)
}

export function isForwardRefCall(call: WrapperCall | null): boolean {
  return call !== null && REACT_FORWARD_REF_FACTORIES.has(call.leaf)
}

export function isMemoCall(call: WrapperCall | null): boolean {
  return call !== null && REACT_MEMO_FACTORIES.has(call.leaf)
}

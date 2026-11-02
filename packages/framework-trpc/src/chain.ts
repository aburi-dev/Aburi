import { calleeName, receiverChain, type SyntaxNode } from "@aburi/core"

export interface Chain {
  /** The call the initializer is, or `null` when it is a member read, whatever that reads through. */
  readonly call: SyntaxNode | null
  /**
   * `<root>.<leaf>` with the steps between dropped, as `calleeName` names a call
   * (`t.procedure.use(x).query(fn)` is `t.query`), or the callee alone for a call to a bare name.
   */
  readonly name: string
  readonly leaf: string
  /** Each property read and method called between the root and the leaf, outermost first. */
  readonly path: readonly string[]
  readonly root: string
}

export function readChain(initializer: SyntaxNode): Chain | null {
  if (initializer.type === "call_expression") {
    const callee = calleeName(initializer)
    const fn = initializer.childForFieldName("function")
    if (callee === null || fn === null) return null
    const object = fn.type === "member_expression" ? fn.childForFieldName("object") : null
    const below = object === null ? { path: [], root: callee.name } : receiverChain(object)
    return { call: initializer, name: callee.name, leaf: callee.leaf, ...below }
  }
  if (initializer.type === "member_expression") {
    const object = initializer.childForFieldName("object")
    const leaf = initializer.childForFieldName("property")?.text ?? ""
    if (object === null || leaf.length === 0) return null
    const below = receiverChain(object)
    return { call: null, name: `${below.root}.${leaf}`, leaf, ...below }
  }
  return null
}

import type { Node } from "web-tree-sitter"
import { parseSource, requireTree } from "./ctx"

export type NodeRead = (node: Node, member: string, value: unknown) => void

/**
 * Runs `run` with every accessor and method of tree-sitter's nodes reporting to `onRead` the node it
 * was called on, its name and what it gave back, so a test can count work rather than time it,
 * which would measure the machine as much as the code.
 */
export async function readingNodes<T>(onRead: NodeRead, run: () => Promise<T>): Promise<T> {
  const tree = requireTree((await parseSource("")).tree)
  const prototype = Object.getPrototypeOf(tree.rootNode) as object
  const originals = Object.getOwnPropertyDescriptors(prototype)
  // A read tree-sitter makes inside another (`text` reads `endIndex`), or that `onRead` makes of
  // the node it is handed, is not a read of the code under test.
  let depth = 0
  const read = (node: Node, member: string, take: () => unknown): unknown => {
    depth += 1
    let value: unknown
    try {
      value = take()
    } finally {
      depth -= 1
    }
    if (depth > 0) return value
    depth += 1
    try {
      onRead(node, member, value)
    } finally {
      depth -= 1
    }
    return value
  }
  for (const [member, descriptor] of Object.entries(originals)) {
    if (member === "constructor") continue
    const get = descriptor.get
    const method: unknown = descriptor.value
    if (get !== undefined) {
      Object.defineProperty(prototype, member, {
        ...descriptor,
        get(this: Node) {
          return read(this, member, () => get.call(this))
        },
      })
    } else if (typeof method === "function") {
      Object.defineProperty(prototype, member, {
        ...descriptor,
        value(this: Node, ...args: unknown[]): unknown {
          return read(this, member, () => method.apply(this, args))
        },
      })
    }
  }
  try {
    return await run()
  } finally {
    for (const [member, descriptor] of Object.entries(originals)) {
      Object.defineProperty(prototype, member, descriptor)
    }
  }
}

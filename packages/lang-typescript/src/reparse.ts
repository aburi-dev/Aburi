import type { Parser, Tree } from "web-tree-sitter"

/** Text put in place of a span of the source for a second parse, and how to tell it took. */
export interface Patch {
  readonly start: number
  readonly end: number
  /** As long as the span, so every position the second tree reports is the source's. */
  readonly text: string
  /** Whether the second tree reads the patch as the repair meant it. */
  holds(tree: Tree): boolean
}

export interface Reparsed {
  readonly tree: Tree
  readonly patches: readonly Patch[]
}

/**
 * Parses the patched source and withdraws every patch the tree does not read as meant, until all
 * that remain hold. The tree is kept only when it reads less broken than `tree`, comparing
 * `damage` element by element, and reads the original text, so no node's text shows a patch.
 */
export function reparsePatched(
  parser: Parser,
  tree: Tree,
  source: string,
  patches: readonly Patch[],
  damage: (tree: Tree) => readonly number[],
): Reparsed | null {
  const before = damage(tree)
  let kept = [...patches].sort((a, b) => a.start - b.start)
  while (kept.length > 0) {
    const candidate = parsePatched(parser, source, kept)
    if (candidate === null) return null
    let adopted = false
    try {
      const holding = kept.filter((patch) => patch.holds(candidate))
      if (holding.length < kept.length) {
        kept = holding
        continue
      }
      if (!isLess(damage(candidate), before)) return null
      adopted = true
      return { tree: candidate, patches: kept }
    } finally {
      if (!adopted) candidate.delete()
    }
  }
  return null
}

function isLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const by = (a[i] ?? 0) - (b[i] ?? 0)
    if (by !== 0) return by < 0
  }
  return false
}

function parsePatched(parser: Parser, source: string, patches: readonly Patch[]): Tree | null {
  let patched = ""
  let from = 0
  for (const { start, end, text } of patches) {
    patched += source.slice(from, start) + text
    from = end
  }
  patched += source.slice(from)
  let parsing = true
  const tree = parser.parse((index) => (parsing ? patched : source).slice(index))
  parsing = false
  return tree
}

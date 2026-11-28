import type { Node, Tree } from "web-tree-sitter"
import type { Patch } from "./reparse"

/**
 * Blanks for each modifier TypeScript takes where the grammar refuses it: `abstract` on an
 * anonymous default-exported class, and `static` on an index signature. Each patch keeps the
 * position of the construct it opens, so the tree can say the modifier was written.
 */
export function refusedModifierPatches(source: string): RefusedModifierPatch[] {
  const patches: RefusedModifierPatch[] = []
  for (const match of source.matchAll(ABSTRACT_DEFAULT_CLASS)) {
    const start = match.index + (match[1]?.length ?? 0)
    const opens = start + "abstract".length + (match[2]?.length ?? 0)
    patches.push(blank(start, "abstract", opens, (tree) => opensDefaultClass(tree, opens)))
  }
  for (const match of source.matchAll(STATIC_INDEX_SIGNATURE)) {
    const opens = match.index + "static".length + (match[1]?.length ?? 0)
    patches.push(blank(match.index, "static", opens, (tree) => opensIndexSignature(tree, opens)))
  }
  return patches
}

export interface RefusedModifierPatch extends Patch {
  readonly modifier: string
  /** Where the construct the modifier belongs to starts. */
  readonly opens: number
}

/** Lets the serializer read the modifiers blanked out of `tree` back onto their constructs. */
export function rememberRefusedModifiers(
  tree: Tree,
  patches: readonly RefusedModifierPatch[],
): void {
  if (patches.length === 0) return
  WRITTEN.set(tree, new Map(patches.map((patch) => [patch.opens, patch.modifier])))
}

/** The modifier written before `node` that the parse had to leave out, if any. */
export function refusedModifierOf(node: Node): string | undefined {
  return WRITTEN.get(node.tree)?.get(node.startIndex)
}

const WRITTEN = new WeakMap<Tree, Map<number, string>>()

const ABSTRACT_DEFAULT_CLASS = /(\bexport\s+default\s+)abstract(\s+)(?=class\b)/g

// An index signature's brackets hold a name and a `:`, which a computed member's key cannot.
const STATIC_INDEX_SIGNATURE =
  /\bstatic(\s+)(?=(?:readonly\s+)?\[\s*[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*\s*:)/gu

function blank(
  start: number,
  modifier: string,
  opens: number,
  holds: (tree: Tree) => boolean,
): RefusedModifierPatch {
  const end = start + modifier.length
  return { start, end, text: " ".repeat(modifier.length), modifier, opens, holds }
}

function opensDefaultClass(tree: Tree, at: number): boolean {
  const keyword = tree.rootNode.descendantForIndex(at, at + 1)
  const declaration = keyword?.parent
  return (
    keyword?.type === "class" &&
    keyword.startIndex === at &&
    declaration?.type === "class" &&
    declaration.startIndex === at &&
    declaration.parent?.type === "export_statement"
  )
}

function opensIndexSignature(tree: Tree, at: number): boolean {
  const token = tree.rootNode.descendantForIndex(at, at + 1)
  const signature = token?.parent
  return (
    (token?.type === "[" || token?.type === "readonly") &&
    token.startIndex === at &&
    signature?.type === "index_signature" &&
    signature.startIndex === at &&
    signature.parent?.type === "class_body"
  )
}

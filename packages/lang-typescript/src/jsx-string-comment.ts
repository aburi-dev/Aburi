import type { Tree } from "web-tree-sitter"
import type { Patch } from "./reparse"

/**
 * A `_` in place of each `<` that opens a JSX attribute's string with `<!--`. The tsx grammar lexes
 * that `<!--` as an HTML comment running to the end of the line, quote and element included, so
 * `html="<!--[if mso]>…"`, how email templates write conditional comments, breaks the file.
 */
export function jsxStringCommentPatches(source: string): Patch[] {
  const patches: Patch[] = []
  for (const opening of source.matchAll(/["']<!--/g)) {
    const start = opening.index + 1
    patches.push({ start, end: start + 1, text: "_", holds: (tree) => opensJsxString(tree, start) })
  }
  return patches
}

function opensJsxString(tree: Tree, at: number): boolean {
  const fragment = tree.rootNode.descendantForIndex(at, at + 1)
  const string = fragment?.parent
  return (
    fragment?.type === "string_fragment" &&
    fragment.startIndex === at &&
    string?.type === "string" &&
    string.startIndex === at - 1 &&
    string.parent?.type === "jsx_attribute"
  )
}

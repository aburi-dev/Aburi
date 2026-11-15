import { it } from "vitest"
import { parseSource, requireTree } from "../fixtures/ctx"
function dump(node: any, depth = 0): string {
  let out = `${"  ".repeat(depth)}${node.type}${node.isExtra ? " [extra]" : ""}${node.isMissing ? " [missing]" : ""}${node.childCount === 0 ? ` ${JSON.stringify(node.text)}` : ""}\n`
  for (const c of node.children) out += dump(c, depth + 1)
  return out
}
it("probe", async () => {
  for (const [src, path] of [["export function f() { g(a ¤ b) }", "src/a.ts"], ["export function f() { g(a # b) }", "src/a.ts"], ["export function f() { g(a @@ b) }", "src/a.ts"]]) {
    const r = await parseSource(src, path)
    console.log(src + "\n" + dump(requireTree(r.tree).rootNode))
  }
})

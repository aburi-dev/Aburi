import { describe, expect, it } from "vitest"
import { idsOf, parseErrorsOf, parseSource, requireTree } from "./fixtures/ctx"

describe("a JSX attribute's string that opens with `<!--`", () => {
  it.each([
    ["double-quoted", 'export const A = () => <R html="<!--[if mso]></td><![endif]-->" />\n'],
    ["single-quoted", "export const A = () => <R html='<!--[if mso]><![endif]-->' />\n"],
    ["with no `-->`", 'export const A = () => <R html="<!--x" />\n'],
    ["holding an empty comment", 'export const A = () => <R html="<!---->" />\n'],
    ["before another attribute", 'export const A = () => <R html="<!--x-->" id="a" />\n'],
    ["on an element with children", 'export const A = () => <div title="<!--x-->">t</div>\n'],
    [
      "twice on one line",
      'export const A = () => <><R html="<!--a-->" /><R html="<!--b-->" /></>\n',
    ],
  ])("parses clean %s", async (_label, source) => {
    expect(await parseErrorsOf(source, "src/a.tsx")).toEqual([])
    expect(await parseErrorsOf(source, "src/a.jsx")).toEqual([])
  })

  it("keeps the declarations after it", async () => {
    const source = 'export const A = () => <R html="<!--x-->" />\nexport function after() {}\n'
    expect((await idsOf(source, "src/a.tsx")).sort()).toEqual([
      "ts:src/a.tsx#A",
      "ts:src/a.tsx#after",
    ])
  })

  it("reads the string as written", async () => {
    const source = 'export const A = () => <R html="<!--x-->" />\n'
    const tree = requireTree((await parseSource(source, "src/a.tsx")).tree)
    const at = source.indexOf('"<!--')
    expect(tree.rootNode.descendantForIndex(at, at + 1)?.parent?.text).toBe('"<!--x-->"')
  })

  it("still reports an error elsewhere in the file, where it is", async () => {
    const source = 'export const A = () => <R html="<!--x-->" />\nf(a b)\n'
    expect(await parseErrorsOf(source, "src/a.tsx")).toEqual(["2:5 syntax error"])
  })

  it.each([
    ["a string that never closes", 'export const A = () => <R html="<!--x />\n'],
    ["an HTML comment among the children", "export const A = () => <div><!--x--></div>\n"],
  ])("still reports %s", async (_label, source) => {
    expect(await parseErrorsOf(source, "src/a.tsx")).not.toEqual([])
  })
})

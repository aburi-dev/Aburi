import { describe, expect, it } from "vitest"
import { idsOf, normalizedOf, parseErrorsOf, parseSource, requireTree } from "./fixtures/ctx"

const lines = (...text: string[]): string => `${text.join("\n")}\n`

describe("a generic call signature written on the line after a member", () => {
  it.each([
    ["after a call signature", lines("export type S = {", "  (): A", "  <U>(u: U): U", "}")],
    [
      "after a generic call signature",
      lines("export interface G {", "  <K extends A>(k: K): K", "  <K extends B>(k: K): B[K]", "}"),
    ],
    ["after a property", lines("export interface P {", "  a: string", "  <K>(k: K): K", "}")],
    ["after a method", lines("export interface M {", "  m(): Promise<A>", "  <K>(k: K): K", "}")],
    [
      "after a signature whose type spans lines",
      lines("export interface L {", "  (", "    r: R,", "  ): Promise<T>", "  <T>(r: R): T", "}"),
    ],
    [
      "with its type parameters on lines of their own",
      lines("export interface T {", "  (): A", "  <", "    U extends A,", "  >(u: U): U", "}"),
    ],
    [
      "below a line comment",
      lines("export interface C {", "  (): A", "", "  // the generic form", "  <U>(u: U): U", "}"),
    ],
    [
      "below a block comment",
      lines("export interface D {", "  (): A", "  /** the generic form */", "  <U>(u: U): U", "}"),
    ],
    ["inside a type annotation", lines("let s: {", "  (): A", "  <U>(u: U): U", "}")],
    ["with CRLF line endings", "export type S = {\r\n  (): A\r\n  <U>(u: U): U\r\n}\r\n"],
    ["indented with a tab", lines("export type S = {", "\t(): A", "\t<U>(u: U): U", "}")],
  ])("parses clean %s", async (_label, source) => {
    expect(await parseErrorsOf(source)).toEqual([])
  })

  it("parses clean in a .tsx file", async () => {
    const source = lines("export type S = {", "  (): A", "  <U>(u: U): U", "}")
    expect(await parseErrorsOf(source, "src/a.tsx")).toEqual([])
  })

  it("keeps the declarations after it", async () => {
    const source = lines(
      "export interface G {",
      "  <K extends A>(k: K): K",
      "  <K extends B>(k: K): K",
      "}",
      "export function after() {}",
      "export class Later {}",
    )
    expect((await idsOf(source)).sort()).toEqual([
      "ts:src/a.ts#G",
      "ts:src/a.ts#Later",
      "ts:src/a.ts#after",
    ])
  })

  it("reads the original text, not the separator", async () => {
    const source = lines("export type S = {", "  (): A", "  <U>(u: U): U", "}")
    expect(requireTree((await parseSource(source)).tree).rootNode.text).toBe(source)
  })

  it("describes the type as the one written with the separator", async () => {
    const bare = lines("export interface G {", "  (): A", "  <U>(u: U): U", "}")
    const separated = lines("export interface G {", "  (): A", " ;<U>(u: U): U", "}")
    expect(await normalizedOf(bare, "ts:src/a.ts#G")).toBe(
      await normalizedOf(separated, "ts:src/a.ts#G"),
    )
  })

  it("leaves a signature the grammar already reads, in a file broken elsewhere", async () => {
    const clean = lines("export interface O {", "  a: { x: 1 }", "  <U>(u: U): U", "}")
    const broken = `${clean}export const z = f(a b)\n`
    expect(await parseErrorsOf(clean)).toEqual([])
    expect(await normalizedOf(broken, "ts:src/a.ts#O")).toBe(
      await normalizedOf(clean, "ts:src/a.ts#O"),
    )
  })

  it("still reports an error elsewhere in the file, where it is", async () => {
    const source = lines("export type S = {", "  (): A", "  <U>(u: U): U", "}", "f(a b)")
    expect(await parseErrorsOf(source)).toEqual(["5:5 syntax error"])
  })

  it.each([
    ["a broken parameter list", lines("export interface I {", "  (): A", "  <U>(u: U: U", "}")],
    ["an unclosed type", lines("export type S = {", "  (): A", "  <U>(u: U): U")],
  ])("still reports %s", async (_label, source) => {
    expect(await parseErrorsOf(source)).not.toEqual([])
  })

  it.each([
    [
      "a type argument list continued from the line above",
      lines("let x: Map<", "  <T>() => T, A>"),
    ],
    ["a comparison continued from the line above", lines("const x = a <", "  b(c)")],
    ["a generic arrow after `=`", lines("const f =", "  <T>(t: T) => t")],
    ["JSX children", lines("const e = (", "  <div>", "    <span>{a}</span>", "  </div>", ")")],
  ])("leaves %s as it parses", async (_label, source) => {
    const path = source.includes("<div>") ? "src/a.tsx" : "src/a.ts"
    expect(await parseErrorsOf(source, path)).toEqual([])
  })
})

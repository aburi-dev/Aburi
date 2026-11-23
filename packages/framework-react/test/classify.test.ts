import { describe, expect, it } from "vitest"
import { classifyReactSymbol } from "../src/index"
import { extracted, extractedNamed, makeCandidate, makeCtx } from "./fixtures/symbol"

const REACT_IMPORT = 'import React, { createContext, forwardRef, memo, useState } from "react"'

async function classified(source: string, name: string) {
  const { candidate, ctx } = await extractedNamed(source, name)
  return classifyReactSymbol(candidate, ctx)
}

describe("classifyReactSymbol", () => {
  it.each([
    [
      "a use* function",
      "export function useThing() { return 1 }",
      "useThing",
      "hook",
      "hook:naming",
    ],
    [
      "a use* function that calls another hook",
      "export function useCounter() { const [c] = useState(0); return c }",
      "useCounter",
      "hook",
      "hook:naming;framework:react:hook:hook-call",
    ],
    [
      "a use* function that returns JSX",
      "export function useOverlay() { return <div /> }",
      "useOverlay",
      "hook",
      "hook:naming",
    ],
    [
      "an arrow-assigned use* function",
      "export const useThing = () => 42",
      "useThing",
      "hook",
      "hook:naming",
    ],
    [
      "a with* function",
      "export function withAuth(Component) { return function Wrapped(p) { return <Component {...p} /> } }",
      "withAuth",
      "hoc",
      "hoc:naming",
    ],
    [
      "a const holding createContext(...)",
      "export const Ctx = createContext(null)",
      "Ctx",
      "context",
      "context:createContext",
    ],
    [
      "a const holding React.createContext(...)",
      "export const Ctx = React.createContext(null)",
      "Ctx",
      "context",
      "context:React.createContext",
    ],
    [
      "a const holding forwardRef(...)",
      "export const Btn = forwardRef((p, r) => <button ref={r} />)",
      "Btn",
      "forward-ref",
      "forward-ref:forwardRef",
    ],
    [
      "a const holding React.memo(...)",
      "export const M = React.memo(Inner)",
      "M",
      "memo",
      "memo:React.memo",
    ],
    [
      "a const holding memo(forwardRef(...)), by its outer call",
      "export const Nested = React.memo(React.forwardRef((p, ref) => <button ref={ref} />))",
      "Nested",
      "memo",
      "memo:React.memo",
    ],
    [
      "a default export written as memo(...)",
      "export default memo(function Row() { return <li /> })",
      "<default>",
      "memo",
      "memo:memo",
    ],
    [
      "a default export written as forwardRef(...)",
      "export default forwardRef((p, r) => <button ref={r} />)",
      "<default>",
      "forward-ref",
      "forward-ref:forwardRef",
    ],
    [
      "a default export written as memo(...) handed a name",
      "export default memo(Row)",
      "<default>",
      "memo",
      "memo:memo",
    ],
    [
      "a default export written as createContext(...)",
      "export default createContext(null)",
      "<default>",
      "context",
      "context:createContext",
    ],
    [
      "a PascalCase function returning <X.Provider>",
      "export function ThemeProvider({ children }) { return <ThemeCtx.Provider value={null}>{children}</ThemeCtx.Provider> }",
      "ThemeProvider",
      "provider",
      "provider",
    ],
    [
      "a PascalCase function returning JSX",
      "export function Section({ children }) { return <section>{children}</section> }",
      "Section",
      "component",
      "component",
    ],
    [
      "an arrow-assigned PascalCase function returning JSX",
      "export const MyComp = () => <div />",
      "MyComp",
      "component",
      "component",
    ],
  ])("classifies %s", async (_label, source, name, kind, tag) => {
    expect(await classified(`${REACT_IMPORT}\n${source}`, name)).toEqual({
      extKind: `framework:react:${kind}`,
      derivedBy: `framework:react:${tag}`,
      confidence: "high",
    })
  })

  it.each([
    ["a plain utility", "export function helper(x: number) { return x + 1 }", "helper"],
    [
      "a PascalCase function that never returns JSX",
      "export function BuildQuery() { return { where: {} } }",
      "BuildQuery",
    ],
    ["a const no wrapper initializes", "export const V = 42", "V"],
    [
      "an anonymous default export, whose name is not PascalCase",
      "export default function() { return <div /> }",
      "<default>",
    ],
  ])("returns null for %s", async (_label, source, name) => {
    expect(await classified(source, name)).toBeNull()
  })

  it.each<[string, string, string, [string, string] | null]>([
    [
      "a hook in a file that imports nothing",
      "export function useDatabase(url: string) { return { url } }",
      "useDatabase",
      ["hook", "medium"],
    ],
    [
      "a Vue composable",
      'import { ref } from "vue"\nexport function useCounter() { return ref(0) }',
      "useCounter",
      ["hook", "medium"],
    ],
    [
      "a hook that calls another hook in a file that imports nothing from React",
      'import { useRouter } from "next/navigation"\nexport function useBack() { const router = useRouter(); return () => router.back() }',
      "useBack",
      ["hook", "high"],
    ],
    [
      "a hook in a file that imports only a type from React",
      'import type { ReactNode } from "react"\nexport function useSlot(): ReactNode { return null }',
      "useSlot",
      ["hook", "high"],
    ],
    [
      "a hook in a file that imports Preact's compatibility layer",
      'import { useState } from "preact/compat"\nexport function useToggle() { return useState(false) }',
      "useToggle",
      ["hook", "high"],
    ],
    [
      "a with* function that renders JSX in a file that imports nothing",
      "export function withAuth(C) { return (p) => <C {...p} /> }",
      "withAuth",
      ["hoc", "high"],
    ],
    [
      "a with* arrow that returns a function in a file that imports nothing",
      "export const withLogging = (fn) => (...args) => fn(...args)",
      "withLogging",
      ["hoc", "medium"],
    ],
    [
      "a with* function that returns a function in a file that imports React",
      `${REACT_IMPORT}\nexport function withTheme(C) { return function Themed(p) { return React.createElement(C, p) } }`,
      "withTheme",
      ["hoc", "high"],
    ],
    [
      "a with* function that returns what its callback resolves to",
      `${REACT_IMPORT}\nexport async function withRetry(fn) { try { return await fn() } catch { return await fn() } }`,
      "withRetry",
      null,
    ],
    [
      "a with* function that returns a call",
      "export function withTransaction(db, fn) { return db.transaction(fn) }",
      "withTransaction",
      null,
    ],
    [
      "a bare createContext(...) in a file that imports nothing",
      "export const Ctx = createContext(null)",
      "Ctx",
      ["context", "medium"],
    ],
    [
      "vm.createContext(...)",
      'import vm from "node:vm"\nexport const sandbox = vm.createContext({})',
      "sandbox",
      null,
    ],
    [
      "React.createContext(...) in a file that does not import React",
      "export const Ctx = React.createContext(null)",
      "Ctx",
      null,
    ],
    [
      "createContext(...) on a namespace React's import binds",
      'import * as R from "react"\nexport const Ctx = R.createContext(null)',
      "Ctx",
      ["context", "high"],
    ],
    [
      "a memo(...) in a file that imports nothing",
      "export const M = memo(Inner)",
      "M",
      ["memo", "medium"],
    ],
    [
      "a component in a file that imports nothing",
      "export function Section() { return <section /> }",
      "Section",
      ["component", "high"],
    ],
  ])("grades %s against the file's imports", async (_label, source, name, expected) => {
    const role = await classified(source, name)
    expect(role === null ? null : [role.extKind, role.confidence]).toEqual(
      expected === null ? null : [`framework:react:${expected[0]}`, expected[1]],
    )
  })

  it.each(["class", "method", "interface", "type", "enum", "namespace"] as const)(
    "returns null for a %s",
    (kind) => {
      expect(classifyReactSymbol(makeCandidate({ kind, name: "X" }), makeCtx())).toBeNull()
    },
  )
})

describe("classifyReactSymbol — a const read from its own initializer", () => {
  /** `"<name> <extKind> <derivedBy>"` per const Symbol, `"<name> -"` for one with no role, sorted. */
  async function constRoles(source: string, path = "src/f.tsx"): Promise<string[]> {
    const { candidates, ctx } = await extracted(source, path)
    return candidates
      .filter((candidate) => candidate.kind === "const")
      .map((candidate) => {
        const role = classifyReactSymbol(candidate, ctx)
        return role === null
          ? `${candidate.name} -`
          : `${candidate.name} ${role.extKind} ${role.derivedBy}`
      })
      .sort()
  }

  it.each([
    [
      "a wrapper declared first",
      `export const ThemeContext = createContext("light"), DEFAULT_THEME = "light"`,
      [
        "DEFAULT_THEME -",
        "ThemeContext framework:react:context framework:react:context:createContext",
      ],
    ],
    [
      "a wrapper declared second",
      "export const PAGE_SIZE = 20, Row = memo((props: { id: string }) => <li>{props.id}</li>)",
      ["PAGE_SIZE -", "Row framework:react:memo framework:react:memo:memo"],
    ],
    [
      "a wrapper declared after another call",
      "export const theme = getTheme(), Ctx = createContext(null)",
      ["Ctx framework:react:context framework:react:context:createContext", "theme -"],
    ],
    [
      "two wrappers",
      "export const A = memo(X), B = React.forwardRef(Y)",
      [
        "A framework:react:memo framework:react:memo:memo",
        "B framework:react:forward-ref framework:react:forward-ref:React.forwardRef",
      ],
    ],
    [
      "`memo(forwardRef(...))` declared second",
      "export const size = 1, Fancy = memo(forwardRef((p, r) => <b ref={r} />))",
      ["Fancy framework:react:memo framework:react:memo:memo", "size -"],
    ],
    [
      "a wrapper declared second in a namespace",
      "export namespace ui {\n  export const size = 1, Row = memo(Inner)\n}",
      ["ui.Row framework:react:memo framework:react:memo:memo", "ui.size -"],
    ],
    [
      "a wrapper beside a call that wraps one",
      "export const Row = memo(Impl), Themed = withTheme(memo(Impl))",
      ["Row framework:react:memo framework:react:memo:memo", "Themed -"],
    ],
  ])("gives each name in a statement its own role: %s", async (_label, source, roles) => {
    expect(await constRoles(source)).toEqual(roles)
  })

  it.each([
    [
      "nested in an array",
      `export const routes = [{ path: "/", element: memo(() => <div />) }]`,
      "routes",
    ],
    [
      "inside an object literal's function",
      "export const handlers = { save: () => forwardRef(() => null) }",
      "handlers",
    ],
    ["as an object literal's value", "export const views = { list: memo(List) }", "views"],
    ["handed to `new`", "export const holder = new Holder(memo(Impl))", "holder"],
    ["in one branch of a conditional", "export const Row = flag ? memo(Impl) : Impl", "Row"],
  ])("gives no role to a const holding a wrapper %s", async (_label, source, name) => {
    expect(await constRoles(source)).toEqual([`${name} -`])
  })

  it("gives no role to a name destructured from a wrapper call", async () => {
    expect(await constRoles("export const { displayName } = memo(Impl)")).toEqual(["displayName -"])
  })

  it.each([
    ["`as`", "export const Row = memo(Impl) as typeof Impl"],
    ["`satisfies`", "export const Row = memo(Impl) satisfies ComponentType"],
    ["`!`", "export const Row = memo(Impl)!"],
    ["parentheses", "export const Row = (memo(Impl))"],
  ])("reads a wrapper through %s", async (_label, source) => {
    expect(await constRoles(source)).toEqual(["Row framework:react:memo framework:react:memo:memo"])
  })

  it.each([
    [
      "type arguments on the call",
      'import React from "react"\nexport const Ctx = React.createContext<Theme | null>(null)',
      "Ctx framework:react:context framework:react:context:React.createContext",
    ],
    [
      "a type annotation on the name",
      'export const Ctx: React.Context<string> = createContext("light")',
      "Ctx framework:react:context framework:react:context:createContext",
    ],
  ])("reads a wrapper call declared with %s", async (_label, source, role) => {
    expect(await constRoles(source)).toEqual([role])
  })

  it.each([
    ['export const Ctx = <Context<string>>createContext("light")', "Ctx"],
    ["export const Row = <any>memo(Inner)", "Row"],
  ])("gives no role to a wrapper behind an old-style type assertion: %s", async (source, name) => {
    expect(await constRoles(source, "src/f.ts")).toEqual([`${name} -`])
  })
})

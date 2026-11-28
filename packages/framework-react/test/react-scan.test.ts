import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { component, frameworkEntries, symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { reactFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("react-scan")

describe("scan — React source shapes across .tsx and .jsx files", () => {
  it("classifies each React shape, and leaves a helper beside them alone", async () => {
    const files: Record<string, string> = {
      "src/Button.tsx":
        "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>\n}\n",
      "src/hooks.tsx":
        "export function useCounter() {\n  const [c, setC] = useState(0)\n  return { c, inc: () => setC(c + 1) }\n}\n",
      "src/context.tsx":
        "import { createContext } from 'react'\nexport const ThemeCtx = createContext(null)\n",
      "src/forward.tsx":
        "export const FancyBtn = React.forwardRef((p, ref) => <button ref={ref} />)\n",
      "src/memo.tsx":
        "export const Cell = React.memo(function Cell(props) { return <td>{props.v}</td> })\n",
      "src/provider.tsx":
        "export function ThemeProvider({ children }) { return <ThemeCtx.Provider value={'dark'}>{children}</ThemeCtx.Provider> }\n",
      "src/withAuth.tsx":
        "export function withAuth(Component) { return function Wrapped(p) { return <Component {...p} /> } }\n",
      "src/legacy.jsx": "export function OldButton() { return <button>legacy</button> }\n",
      "src/format.tsx": "export function formatDate(d: Date) { return d.toISOString() }\n",
    }
    for (const [path, source] of Object.entries(files)) await workspace.writeSource(path, source)

    const { ir } = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const extKinds = Object.fromEntries(ir.symbols.map((symbol) => [symbol.name, symbol.extKind]))

    expect(extKinds).toMatchObject({
      Button: "framework:react:component",
      useCounter: "framework:react:hook",
      ThemeCtx: "framework:react:context",
      FancyBtn: "framework:react:forward-ref",
      Cell: "framework:react:memo",
      ThemeProvider: "framework:react:provider",
      withAuth: "framework:react:hoc",
      OldButton: "framework:react:component",
      formatDate: null,
    })
  })

  it("gives a const a context, memo or forward-ref role only when its own initializer is that call", async () => {
    await workspace.writeSource(
      "src/ui.tsx",
      [
        `import { createContext, forwardRef, memo } from "react"`,
        `export const ThemeContext = createContext("light"), DEFAULT_THEME = "light"`,
        `export const PAGE_SIZE = 20, Row = memo((props: { id: string }) => <li>{props.id}</li>)`,
        `export const routes = [{ path: "/", element: memo(() => <div />) }]`,
        `export const handlers = { save: () => forwardRef(() => null) }`,
        `export const label = String(42)`,
      ].join("\n"),
    )

    const { ir } = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const consts = ir.symbols.filter((symbol) => symbol.kind === "const")

    expect(Object.fromEntries(consts.map((symbol) => [symbol.name, symbol.extKind]))).toEqual({
      ThemeContext: "framework:react:context",
      DEFAULT_THEME: null,
      PAGE_SIZE: null,
      Row: "framework:react:memo",
      routes: null,
      handlers: null,
      label: null,
    })
  })

  it("classifies a provider by every element it returns, while a guarded layout and a helper's provider stay components", async () => {
    await workspace.writeSource(
      "src/auth.tsx",
      [
        'import { createContext, useState, type ReactNode } from "react"',
        'import { Spinner } from "./spinner"',
        "",
        "type User = { id: string }",
        "export const AuthContext = createContext<User | null>(null)",
        "",
        "export function AuthProvider({ children }: { children: ReactNode }) {",
        "  const [user] = useState<User | null | undefined>(undefined)",
        "  if (user === undefined) return <Spinner />",
        "  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>",
        "}",
        "",
        "export function GuardNull({ children }: { children: ReactNode }) {",
        "  const [user] = useState<User | null | undefined>(undefined)",
        "  if (user === undefined) return null",
        "  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>",
        "}",
        "",
        "export const ParenArrow = ({ children }: { children: ReactNode }) => (",
        "  <AuthContext.Provider value={null}>{children}</AuthContext.Provider>",
        ")",
        "",
        "export function Conditional({ children, loading }: { children: ReactNode; loading: boolean }) {",
        "  const [user] = useState<User | null>(null)",
        "  return loading ? <Spinner /> : <AuthContext.Provider value={user}>{children}</AuthContext.Provider>",
        "}",
        "",
        "export function Gate({ children }: { children: ReactNode }) {",
        "  const [user] = useState<User | null | undefined>(undefined)",
        "  if (user === undefined) return <Spinner />",
        "  return <main>{children}</main>",
        "}",
        "",
        "export function Badge({ user }: { user: User }) {",
        "  const provide = (node: ReactNode) => { return <AuthContext.Provider value={user}>{node}</AuthContext.Provider> }",
        "  return <span>{provide(user.id)}</span>",
        "}",
        "",
      ].join("\n"),
    )

    const { ir } = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const extKinds = Object.fromEntries(ir.symbols.map((symbol) => [symbol.name, symbol.extKind]))

    expect(extKinds).toMatchObject({
      AuthProvider: "framework:react:provider",
      GuardNull: "framework:react:provider",
      ParenArrow: "framework:react:provider",
      Conditional: "framework:react:provider",
      Gate: "framework:react:component",
      Badge: "framework:react:component",
    })
  })
})

describe("scan — what a component returns", () => {
  it("gives the component role to a capitalised function that returns an element, and not to one that only builds one", async () => {
    await workspace.writeSource(
      "src/format.tsx",
      [
        'import { renderToStaticMarkup } from "react-dom/server"',
        'import { ImageResponse } from "next/og"',
        "export function Format(value: number): string {",
        "  const preview = <span>{value}</span>",
        "  console.debug(preview)",
        "  return value.toFixed(2)",
        "}",
        "export function RenderEmail(name: string): string {",
        "  return renderToStaticMarkup(<p>Hello {name}</p>)",
        "}",
        "export async function GET() { return new ImageResponse(<div>Hello</div>) }",
        "export function Greeting({ name }: { name: string }) { return <p>Hello {name}</p> }",
        "export function List({ items }: { items: string[] }) { return items.map((i) => <li key={i}>{i}</li>) }",
        "export function Slot({ children }: { children: React.ReactNode }) { return children }",
      ].join("\n"),
    )

    const { ir } = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })

    expect(Object.fromEntries(ir.symbols.map((symbol) => [symbol.name, symbol.extKind]))).toEqual({
      Format: null,
      RenderEmail: null,
      GET: null,
      Greeting: "framework:react:component",
      List: "framework:react:component",
      Slot: "framework:react:component",
    })
  })
})

describe("scan — the frameworks of a file's Component", () => {
  it("leaves the code of a Component that records frameworks, React not among them, alone", async () => {
    await workspace.writeSource(
      "apps/api/src/db.ts",
      [
        "export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> { return fn() }",
        "export function useDatabase(url: string) { return { url } }",
      ].join("\n"),
    )
    await workspace.writeSource(
      "apps/web/src/Button.tsx",
      "export function Button() { return <button /> }\nexport function useToggle() { return true }\n",
    )
    await workspace.writeSource(
      "scripts/useEnv.ts",
      "export function useEnv() { return process.env }\n",
    )

    const { ir } = await scanWith(
      workspace.root,
      { languages: [langTypescriptPlugin], frameworks: [reactFrameworkPlugin] },
      {},
      {
        components: [
          component({ id: "api", name: "api", frameworks: ["express"] }),
          component({ id: "web", name: "web", frameworks: ["react"] }),
        ],
      },
    )

    expect(Object.fromEntries(ir.symbols.map((symbol) => [symbol.name, symbol.extKind]))).toEqual({
      withTransaction: null,
      useDatabase: null,
      Button: "framework:react:component",
      useToggle: "framework:react:hook",
      useEnv: "framework:react:hook",
    })
  })
})

describe("scan — a call's derivedBy", () => {
  /** `"<extKind> <the plugin's derivedBy entries>"` for the Symbol `name` that `source` declares. */
  async function classified(source: string, name: string): Promise<string> {
    await workspace.writeSource("src/x.tsx", source)
    const result = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const symbol = symbolNamed(result, name)
    return [symbol.extKind, ...frameworkEntries(symbol, "framework:react:")].join(" ")
  }

  const classifiedConst = (initializer: string) =>
    classified(`import React from "react"\nexport const X = ${initializer}\n`, "X")
  const classifiedHook = (returned: string) =>
    classified(`export function useCounter() {\n  return ${returned}\n}\n`, "useCounter")

  it.each([
    [
      "a memo whose member is wrapped onto a second line",
      "React\n  .memo(Inner)",
      "React.memo(Inner)",
      "framework:react:memo framework:react:memo:React.memo",
    ],
    [
      "a memo whose dot ends a line",
      "React.\n  memo(Inner)",
      "React.memo(Inner)",
      "framework:react:memo framework:react:memo:React.memo",
    ],
    [
      "a context after a comment holding a ;",
      "React /* legacy; see the runbook */ .createContext(null)",
      "React.createContext(null)",
      "framework:react:context framework:react:context:React.createContext",
    ],
    [
      "a forwardRef on a receiver cast to its type",
      "(React as any).forwardRef((p, r) => <b ref={r} />)",
      "React.forwardRef((p, r) => <b ref={r} />)",
      "framework:react:forward-ref framework:react:forward-ref:React.forwardRef",
    ],
  ])("names %s as its one-line spelling does", async (_label, written, oneLine, expected) => {
    expect(await classifiedConst(written)).toBe(expected)
    expect(await classifiedConst(oneLine)).toBe(expected)
  })

  it.each([
    ["whose dot ends a line", "React.\n    useState(0)"],
    ["with a comment after its dot", "React./* a */useState(0)"],
  ])("finds a hook call %s as its one-line spelling does", async (_label, written) => {
    const expected =
      "framework:react:hook framework:react:hook:naming framework:react:hook:hook-call"
    expect(await classifiedHook(written)).toBe(expected)
    expect(await classifiedHook("React.useState(0)")).toBe(expected)
  })

  it.each([
    [
      "a call by the name the call is made through",
      "loadReact().memo(() => <div />)",
      "framework:react:memo framework:react:memo:loadReact.memo",
    ],
    [
      "something that is not a name as computed",
      "new Registry().memo(() => <div />)",
      "framework:react:memo framework:react:memo:<computed>.memo",
    ],
  ])("names a receiver that is %s", async (_label, initializer, expected) => {
    expect(await classifiedConst(initializer)).toBe(expected)
  })
})

describe("scan — React's naming conventions graded by the file's imports", () => {
  it("gives a retry helper and a vm context no role, and grades a use* function by whether its file imports React", async () => {
    await workspace.writeSource(
      "src/db.ts",
      [
        'import vm from "node:vm"',
        "",
        "export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {",
        "  for (let i = 0; ; i++) {",
        "    try {",
        "      return await fn()",
        "    } catch (error) {",
        "      if (i + 1 >= attempts) throw error",
        "    }",
        "  }",
        "}",
        "",
        "export function useDatabase(url: string) {",
        "  return { url }",
        "}",
        "",
        "export const sandbox = vm.createContext({})",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/theme.ts",
      [
        'import type { ReactNode } from "react"',
        "",
        "export function useThemeSlot(slot: ReactNode) {",
        "  return { slot }",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const graded = (name: string) => {
      const symbol = symbolNamed(result, name)
      return [symbol.extKind, symbol.confidence]
    }

    expect(symbolNamed(result, "withRetry").extKind).toBeNull()
    expect(symbolNamed(result, "sandbox").extKind).toBeNull()
    expect(graded("useDatabase")).toEqual(["framework:react:hook", "medium"])
    expect(graded("useThemeSlot")).toEqual(["framework:react:hook", "high"])
  })
})

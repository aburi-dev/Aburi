import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { component, symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { nextFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("app-router-scan")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], frameworks: [nextFrameworkPlugin] })

describe("scan — App Router special files", () => {
  it.each([
    ["page", "Page"],
    ["layout", "Layout"],
    ["template", "Template"],
    ["loading", "Loading"],
    ["error", "ErrorBoundary"],
    ["not-found", "NotFound"],
  ])(
    "classifies the default export of app/**/%s.tsx, and not a helper beside it",
    async (role, name) => {
      const file = `app/dashboard/${role}.tsx`
      await workspace.writeSource(
        file,
        [
          "export function formatDate(d: Date) { return d.toISOString() }",
          `export default function ${name}() { return null }`,
          "",
        ].join("\n"),
      )

      const result = await scanWorkspace()

      expect(symbolById(result, `ts:${file}#${name}`).extKind).toBe(`framework:next:${role}`)
      expect(symbolById(result, `ts:${file}#formatDate`).extKind).toBeNull()
    },
  )

  it.each([
    ["by `export default`", "export default Page"],
    ["by an export clause", "export { Page as default }"],
  ])(
    "classifies a page whose default export is written apart from its declaration, %s",
    async (_label, exportLine) => {
      await workspace.writeSource(
        "app/dashboard/page.tsx",
        ["const Page = () => {", "  return null", "}", exportLine, ""].join("\n"),
      )

      const result = await scanWorkspace()

      expect(symbolById(result, "ts:app/dashboard/page.tsx#Page").extKind).toBe(
        "framework:next:page",
      )
    },
  )

  it.each([
    [
      "written as the call",
      ["export default withAuth(function Page() {", "  return null", "})"],
      "<default>",
    ],
    [
      "bound and exported apart",
      ["const Page = withAuth(() => {", "  return null", "})", "export default Page"],
      "Page",
    ],
  ])("classifies a page wrapped in a call that is handed it, %s", async (_label, lines, name) => {
    await workspace.writeSource("app/dashboard/page.tsx", [...lines, ""].join("\n"))

    const page = symbolById(await scanWorkspace(), `ts:app/dashboard/page.tsx#${name}`)

    expect([page.kind, page.extKind]).toEqual(["const", "framework:next:page"])
  })

  it("classifies a page whose default function is written in parentheses", async () => {
    await workspace.writeSource(
      "app/dashboard/page.tsx",
      ["export default (function Page() {", "  return <main />", "})", ""].join("\n"),
    )

    const page = symbolById(await scanWorkspace(), "ts:app/dashboard/page.tsx#<default>")

    expect([page.kind, page.extKind]).toEqual(["function", "framework:next:page"])
  })

  it.each<[string, string[], Record<string, string[]>]>([
    [
      "functions declared with the export keyword",
      [
        "export async function GET() { return new Response('ok') }",
        "export async function POST() { return new Response('created') }",
      ],
      { GET: ["GET"], POST: ["POST"] },
    ],
    [
      "an arrow assigned to an exported const",
      ["export const GET = async () => new Response('ok')"],
      { GET: ["GET"] },
    ],
    [
      "consts destructured from Auth.js's handlers",
      ['import { handlers } from "@/auth"', "export const { GET, POST } = handlers"],
      { GET: ["GET"], POST: ["POST"] },
    ],
    [
      "a const a wrapping call initialises",
      [
        'import { auth } from "@/auth"',
        "export const GET = auth(async (req) => Response.json(req.auth))",
      ],
      { GET: ["GET"] },
    ],
    [
      "a function an export clause names",
      ["async function POST() { return new Response('created') }", "export { POST }"],
      { POST: ["POST"] },
    ],
    [
      "one handler an export clause names under two verbs",
      [
        'import NextAuth from "next-auth"',
        "const handler = NextAuth({})",
        "export { handler as GET, handler as POST }",
      ],
      { handler: ["GET", "POST"] },
    ],
  ])("classifies %s as the routes the module exports", async (_label, lines, routes) => {
    await workspace.writeSource("app/api/users/route.ts", [...lines, ""].join("\n"))

    const result = await scanWorkspace()

    for (const [name, verbs] of Object.entries(routes)) {
      const handler = symbolById(result, `ts:app/api/users/route.ts#${name}`)
      expect(handler.extKind).toBe("framework:next:route")
      expect(
        handler.derivedBy.filter((token) => token.startsWith("framework:next:route:")),
      ).toEqual(verbs.map((verb) => `framework:next:route:${verb}`))
    }
  })

  it.each(["tsx", "jsx"])("classifies the verb of a route.%s that renders JSX", async (ext) => {
    const file = `app/api/og/route.${ext}`
    await workspace.writeSource(
      file,
      [
        'import { ImageResponse } from "next/og"',
        "export async function GET() {",
        "  return new ImageResponse(<div>Hello</div>, { width: 1200, height: 630 })",
        "}",
        "",
      ].join("\n"),
    )

    const handler = symbolById(await scanWorkspace(), `ts:${file}#GET`)

    expect(handler.extKind).toBe("framework:next:route")
    expect(handler.derivedBy).toContain("framework:next:route:GET")
  })

  it.each([
    [
      "a function of a route file named after a verb the module does not export",
      "app/api/hook/route.ts",
      [
        "function OPTIONS() { return new Response(null, { status: 204 }) }",
        "export async function GET() { return OPTIONS() }",
      ],
      "OPTIONS",
    ],
    [
      "an export of a route file that is no HTTP verb",
      "app/api/users/route.ts",
      [
        "export const dynamic = 'force-dynamic'",
        "export async function GET() { return new Response('ok') }",
      ],
      "dynamic",
    ],
    [
      "a verb-named const exported from a file that is no route",
      "app/api/auth/handlers.ts",
      ['import { handlers } from "@/auth"', "export const { GET, POST } = handlers"],
      "GET",
    ],
    [
      "a function a route file exports only through a type-only clause",
      "app/api/users/route.ts",
      ["async function handler() { return new Response('ok') }", "export type { handler as GET }"],
      "handler",
    ],
    [
      "a verb-named function a route file exports through CommonJS",
      "app/api/users/route.js",
      ["function GET() { return new Response('ok') }", "module.exports = { GET }"],
      "GET",
    ],
  ])("does not classify %s", async (_label, file, lines, name) => {
    await workspace.writeSource(file, [...lines, ""].join("\n"))

    const result = await scanWorkspace()

    expect(symbolById(result, `ts:${file}#${name}`).extKind).toBeNull()
  })

  it("finds no route in a route file that only re-exports its verbs", async () => {
    await workspace.writeSource("app/api/auth/route.ts", 'export { GET, POST } from "@/auth"\n')

    const { ir } = await scanWorkspace()

    expect(ir.symbols.filter((symbol) => symbol.extKind === "framework:next:route")).toEqual([])
  })

  it("tags a page in a 'use client' module with both its role and the directive", async () => {
    await workspace.writeSource(
      "app/interactive/page.tsx",
      ["'use client'", "", "export default function Interactive() { return null }", ""].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolById(result, "ts:app/interactive/page.tsx#Interactive").derivedBy).toEqual(
      expect.arrayContaining(["framework:next:page", "framework:next:client-component"]),
    )
  })
})

describe("scan — the App Router of each Next.js project", () => {
  it("routes the app/ at the Component's root only, outside private folders", async () => {
    const files: Record<string, string> = {
      "apps/app/app/page.tsx": "export default function Home() { return <main /> }\n",
      "apps/app/app/_components/error.tsx":
        "export default function ErrorBanner({ message }: { message: string }) { return <p>{message}</p> }\n",
      "apps/app/components/loading.tsx":
        'export default function Spinner() { return <div className="spinner" /> }\n',
      "apps/app/src/app/page.tsx": "export default function Shadowed() { return null }\n",
    }
    for (const [path, source] of Object.entries(files)) await workspace.writeSource(path, source)

    const { ir } = await scanWith(
      workspace.root,
      { languages: [langTypescriptPlugin], frameworks: [nextFrameworkPlugin] },
      {},
      { components: [component({ id: "app", name: "app", frameworks: ["nextjs", "react"] })] },
    )

    expect(Object.fromEntries(ir.symbols.map((symbol) => [symbol.name, symbol.extKind]))).toEqual({
      Home: "framework:next:page",
      ErrorBanner: null,
      Spinner: null,
      Shadowed: "framework:next:page",
    })
  })
})

describe("scan — server actions", () => {
  it.each([
    ["an action module beside a route", "app/posts/actions.ts"],
    ["an action module outside app/", "src/actions/posts.ts"],
    ["an action module in lib/", "lib/actions.ts"],
  ])("classifies every exported async function of %s", async (_label, file) => {
    await workspace.writeSource(
      file,
      [
        '"use server"',
        'import { revalidatePath } from "next/cache"',
        "import { actionClient } from './safe-action'",
        "export async function deletePost(id: string) { revalidatePath(id) }",
        "export const archivePost = async (id: string) => { revalidatePath(id) }",
        "export const publishPost = actionClient.action(async ({ id }) => { revalidatePath(id) })",
        "async function renamePost(id: string) { revalidatePath(id) }",
        "export { renamePost as rename }",
        "async function audit(id: string) { console.log(id) }",
        "export default async function createPost() {}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const extKind = (name: string) => symbolById(result, `ts:${file}#${name}`).extKind

    for (const name of ["deletePost", "archivePost", "publishPost", "renamePost", "createPost"]) {
      expect(extKind(name)).toBe("framework:next:server-action")
    }
    expect(extKind("audit")).toBeNull()
  })

  it.each([
    ["no directive", ["export async function deletePost() {}"]],
    [
      "a directive after another statement",
      ['import "server-only"', '"use server"', "export async function deletePost() {}"],
    ],
    ["a 'use client' module", ['"use client"', "export async function deletePost() {}"]],
  ])("leaves the exported async functions of a module with %s alone", async (_label, lines) => {
    await workspace.writeSource("lib/actions.ts", [...lines, ""].join("\n"))

    const result = await scanWorkspace()

    expect(symbolById(result, "ts:lib/actions.ts#deletePost").extKind).toBeNull()
  })
})

describe("scan — middleware", () => {
  it.each([
    [
      "middleware.ts",
      "export function middleware(request: Request) { return Response.redirect(request.url) }",
      "middleware",
    ],
    ["src/middleware.ts", "export const middleware = auth((request) => undefined)", "middleware"],
    [
      "middleware.ts",
      "export default function gate(request: Request) { return undefined }",
      "gate",
    ],
    ["proxy.ts", "export function proxy(request: Request) { return undefined }", "proxy"],
  ])("classifies what %s hands Next.js: %s", async (file, source, name) => {
    await workspace.writeSource(
      file,
      [source, 'export const config = { matcher: ["/dashboard/:path*"] }', ""].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolById(result, `ts:${file}#${name}`).extKind).toBe("framework:next:middleware")
    expect(symbolById(result, `ts:${file}#config`).extKind).toBeNull()
  })

  it.each([
    [
      "a middleware export of proxy.ts",
      "proxy.ts",
      "export function middleware() {}",
      "middleware",
    ],
    [
      "a middleware.ts below the project directory",
      "lib/middleware.ts",
      "export function middleware() {}",
      "middleware",
    ],
    [
      "a function middleware.ts does not export",
      "middleware.ts",
      "function middleware() {}\nexport const config = {}",
      "middleware",
    ],
  ])("leaves %s alone", async (_label, file, source, name) => {
    await workspace.writeSource(file, `${source}\n`)

    const result = await scanWorkspace()

    expect(symbolById(result, `ts:${file}#${name}`).extKind).toBeNull()
  })
})

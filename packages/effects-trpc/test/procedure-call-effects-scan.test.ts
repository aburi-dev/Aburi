import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { irSchemaViolations, symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { trpcEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("procedure-call-effects")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [trpcEffectsPlugin] })

describe("scan — tRPC procedure calls", () => {
  it("records each call a vanilla client makes once, and nothing around it", async () => {
    await workspace.writeSource(
      "src/api/users.ts",
      [
        'import { createTRPCClient, httpBatchLink } from "@trpc/client"',
        'import type { AppRouter } from "../server"',
        "",
        'const client = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/api" })] })',
        "",
        "export async function loadUser(id: string) {",
        '  report("loading", id)',
        "  return client.user.byId.query({ id }).then((user) => user)",
        "}",
        "",
        "export async function createUser(name: string) {",
        "  return await client.user.create.mutate({ name })",
        "}",
        "",
        "export function watch() {",
        "  client.onAdd.subscribe(undefined, { onData: () => {} })",
        "}",
        "",
        "export class UserGateway {",
        "  constructor(private readonly trpc: typeof client) {}",
        "  async byId(id: string) {",
        "    return await this.trpc.user.byId.query({ id })",
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const loadUser = symbolNamed(result, "loadUser")

    expect(loadUser.effects).toMatchObject([
      {
        id: "network.rpc",
        target: "client.user.byId.query",
        confidence: "high",
        derivedBy: "effects-plugin:trpc:query:user.byId",
      },
    ])
    expect(loadUser.calls.map((c) => c.target).sort()).toEqual([
      "client.user.byId.query.then",
      "report",
    ])
    expect(symbolNamed(result, "createUser").effects).toMatchObject([
      {
        target: "client.user.create.mutate",
        derivedBy: "effects-plugin:trpc:mutation:user.create",
      },
    ])
    expect(symbolNamed(result, "watch").effects).toMatchObject([
      { target: "client.onAdd.subscribe", derivedBy: "effects-plugin:trpc:subscription:onAdd" },
    ])
    expect(symbolNamed(result, "UserGateway.byId").effects).toMatchObject([
      { target: "this.trpc.user.byId.query", derivedBy: "effects-plugin:trpc:query:user.byId" },
    ])
  })

  it("records the React Query hooks a component calls", async () => {
    await workspace.writeSource(
      "src/components/PostList.tsx",
      [
        'import { createTRPCReact } from "@trpc/react-query"',
        'import type { AppRouter } from "../server"',
        "",
        "const trpc = createTRPCReact<AppRouter>()",
        "",
        "export function PostList() {",
        "  const posts = trpc.post.list.useQuery()",
        "  const add = trpc.post.add.useMutation()",
        "  return { posts, add }",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolNamed(result, "PostList").effects).toMatchObject([
      { target: "trpc.post.list.useQuery", derivedBy: "effects-plugin:trpc:query:post.list" },
      { target: "trpc.post.add.useMutation", derivedBy: "effects-plugin:trpc:mutation:post.add" },
    ])
  })

  it("records the procedures a component names through the TanStack integration's options", async () => {
    await workspace.writeSource(
      "src/components/Greeting.tsx",
      [
        'import { useMutation, useQuery } from "@tanstack/react-query"',
        'import { createTRPCContext } from "@trpc/tanstack-react-query"',
        'import type { AppRouter } from "../server"',
        "",
        "export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>()",
        "",
        "export function Greeting() {",
        "  const trpc = useTRPC()",
        '  const greeting = useQuery(trpc.greeting.queryOptions({ name: "Jerry" }))',
        "  const createUser = useMutation(trpc.createUser.mutationOptions())",
        '  return <button onClick={() => createUser.mutate({ name: "x" })}>{greeting.data}</button>',
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(
      symbolNamed(result, "Greeting").effects.map((e) => [e.target, e.confidence, e.derivedBy]),
    ).toEqual([
      ["trpc.greeting.queryOptions", "medium", "effects-plugin:trpc:query:greeting"],
      ["trpc.createUser.mutationOptions", "medium", "effects-plugin:trpc:mutation:createUser"],
    ])
  })

  it.each([
    [
      "a router definition, which imports @trpc/server",
      [
        'import { initTRPC } from "@trpc/server"',
        'import { z } from "zod"',
        "",
        "const t = initTRPC.create()",
        "const publicProcedure = t.procedure",
        "",
        "export function createAppRouter() {",
        "  return t.router({",
        "    user: t.router({",
        "      byId: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => input.id),",
        "    }),",
        "  })",
        "}",
        "",
      ],
      "publicProcedure.input.query",
    ],
    [
      "a file that imports no tRPC module",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export async function listUsers(prisma: PrismaClient) {",
        "  return prisma.user.byId.query()",
        "}",
        "",
      ],
      "prisma.user.byId.query",
    ],
  ])("records nothing in %s", async (_label, lines, procedureCall) => {
    await workspace.writeSource("src/server.ts", lines.join("\n"))

    const result = await scanWorkspace()

    expect(result.ir.symbols.flatMap((s) => s.calls.map((c) => c.target))).toContain(procedureCall)
    expect(result.ir.symbols.flatMap((s) => s.effects)).toEqual([])
    expect(result.ir.stats.declinedCalls).toBeUndefined()
  })

  it("classifies a client's query beside a router, and names the builder's query it declines", async () => {
    await workspace.writeSource(
      "src/server.ts",
      [
        'import { createTRPCClient } from "@trpc/client"',
        'import { initTRPC } from "@trpc/server"',
        "",
        "const t = initTRPC.create()",
        "",
        "export function buildRouter() {",
        "  return t.router({ ping: t.procedure.query(() => 'pong') })",
        "}",
        "",
        "export async function warmUp(client: ReturnType<typeof createTRPCClient>) {",
        "  await client.health.ping.query()",
        "  await client.health.reset.mutate()",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(result.ir.stats.declinedCalls).toEqual([
      {
        plugin: "effects-trpc",
        symbolId: "ts:src/server.ts#buildRouter",
        target: "t.procedure.query",
        line: 7,
        reason: "effects-plugin:trpc:procedure-query",
      },
    ])
    expect(symbolNamed(result, "warmUp").effects.map((e) => [e.target, e.derivedBy])).toEqual([
      ["client.health.ping.query", "effects-plugin:trpc:query:health.ping"],
      ["client.health.reset.mutate", "effects-plugin:trpc:mutation:health.reset"],
    ])
    expect(irSchemaViolations(result.ir)).toEqual([])
  })

  it("reads another library's query inside a resolver as a client call, as a known limit", async () => {
    await workspace.writeSource(
      "src/router.ts",
      [
        'import { createTRPCClient } from "@trpc/client"',
        'import { initTRPC } from "@trpc/server"',
        "",
        "const t = initTRPC.create()",
        "",
        "export function buildRouter() {",
        "  return t.router({ count: t.procedure.query(({ ctx }) => ctx.db.query(sql)) })",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(result.ir.stats.declinedCalls?.map((entry) => entry.target)).toEqual([
      "t.procedure.query",
    ])
    expect(symbolNamed(result, "buildRouter").effects.map((e) => [e.target, e.derivedBy])).toEqual([
      ["ctx.db.query", "effects-plugin:trpc:query:db"],
    ])
  })
})

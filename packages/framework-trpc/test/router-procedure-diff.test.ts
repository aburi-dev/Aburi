import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffOfEditWith } from "@aburi/test-harness"
import { soleChange, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { trpcFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("router-procedure")

const lineup = { languages: [langTypescriptPlugin], frameworks: [trpcFrameworkPlugin] }

const router = (...resolver: string[]) =>
  [
    'import { initTRPC, TRPCError } from "@trpc/server"',
    "const t = initTRPC.create()",
    "export const postRouter = t.router({",
    "  byId: t.procedure.query(({ ctx, input }) => {",
    ...resolver.map((line) => `    ${line}`),
    "    return ctx.db.post.findUnique({ where: { id: input } })",
    "  }),",
    "})",
    "",
  ].join("\n")

describe("diff — a procedure written inside a router", () => {
  it("reports an edit to its resolver as a logic change to the router", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      "src/server.ts",
      router(),
      router('if (!input) throw new TRPCError({ code: "BAD_REQUEST" })'),
    )

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    const change = soleChange(diff.symbols, "changed")
    expect(change.after.id).toBe("ts:src/server.ts#postRouter")
    expect(change.delta.logicChanged).toBe(true)
  })
})

describe("diff — the base procedure of a procedure written inside a router", () => {
  const postRouter = (base: string) =>
    [
      'import { createTRPCRouter, protectedProcedure, publicProcedure } from "./trpc"',
      "export const postRouter = createTRPCRouter({",
      "  list: publicProcedure.query(() => []),",
      `  delete: ${base}`,
      "    .input(z.object({ id: z.string() }))",
      "    .mutation(({ input }) => input.id),",
      "})",
      "",
    ].join("\n")

  it("reports switching it to another as a logic change that names both", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      "src/post.ts",
      postRouter("protectedProcedure"),
      postRouter("publicProcedure"),
    )

    const change = soleChange(diff.symbols, "changed")
    expect(change.after.id).toBe("ts:src/post.ts#postRouter")
    expect(change.delta).toMatchObject({
      logicChanged: true,
      middleware: {
        added: ["delete:publicProcedure"],
        removed: ["delete:protectedProcedure"],
        reordered: false,
      },
    })
  })

  it("reads swapping two keys as no change to the router's logic, as tRPC serves each by its key", async () => {
    const LIST = "  list: publicProcedure.query(() => []),"
    const REMOVE = "  remove: protectedProcedure.mutation(() => 1),"
    const keyed = (...procedures: string[]) =>
      [
        'import { createTRPCRouter, protectedProcedure, publicProcedure } from "./trpc"',
        "export const postRouter = createTRPCRouter({",
        ...procedures,
        "})",
        "",
      ].join("\n")

    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      "src/post.ts",
      keyed(LIST, REMOVE),
      keyed(REMOVE, LIST),
    )

    const change = soleChange(diff.symbols, "changed")
    expect(change.after.id).toBe("ts:src/post.ts#postRouter")
    expect(change.delta).toMatchObject({
      logicChanged: false,
      middleware: { added: [], removed: [], reordered: false },
    })
  })
})

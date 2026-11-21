import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { trpcFrameworkPlugin } from "@aburi/framework-trpc"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffIRs, scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"

const workspace = useScratchWorkspace("trpc-procedure")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [trpcFrameworkPlugin],
    effects: [prismaEffectsPlugin],
  })

describe("scan — tRPC procedures whose resolvers reach a database", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/server/user.ts",
      [
        'import { initTRPC } from "@trpc/server"',
        'import { PrismaClient } from "@prisma/client"',
        "",
        "const t = initTRPC.create()",
        "const prisma = new PrismaClient()",
        "",
        "export const list = t.procedure.query(() => prisma.user.findMany())",
        "",
        "export const create = t.procedure",
        "  .input(userInput)",
        "  .mutation(({ input }) => prisma.user.create({ data: input }))",
        "",
      ].join("\n"),
    )
  })

  it("puts each resolver's effect on the procedure that runs it", async () => {
    const result = await scanWorkspace()
    const list = symbolNamed(result, "list")
    const create = symbolNamed(result, "create")

    expect([list.extKind, create.extKind]).toEqual([
      "framework:trpc:procedure",
      "framework:trpc:procedure",
    ])
    expect(list.effects.map((e) => e.id)).toEqual(["db.read"])
    expect(create.effects.map((e) => e.id)).toEqual(["db.write"])
  })
})

describe("scan — a procedure built on a base procedure and a named middleware", () => {
  const trpcFile = (
    sessionRead: string,
    guard = '  if (!ctx.sessionId) throw new Error("UNAUTHORIZED")',
  ) =>
    [
      'import { initTRPC } from "@trpc/server"',
      'import { PrismaClient } from "@prisma/client"',
      "",
      "const t = initTRPC.create()",
      "const prisma = new PrismaClient()",
      "",
      "export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {",
      guard,
      `  await ${sessionRead}`,
      "  return next()",
      "})",
      "",
      "export const isAdmin = t.middleware(async ({ ctx, next }) => {",
      "  await prisma.membership.findFirst({ where: { userId: ctx.userId } })",
      "  return next()",
      "})",
      "",
    ].join("\n")

  beforeEach(async () => {
    await workspace.writeSource(
      "src/server/trpc.ts",
      trpcFile("prisma.session.findUnique({ where: { id: ctx.sessionId } })"),
    )
    await workspace.writeSource(
      "src/server/post.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        'import { isAdmin, protectedProcedure } from "./trpc"',
        "",
        "const prisma = new PrismaClient()",
        "",
        "export const deletePost = protectedProcedure",
        "  .use(isAdmin)",
        "  .mutation(({ input }) => prisma.post.delete({ where: { id: input } }))",
        "",
      ].join("\n"),
    )
  })

  it("carries the effects of what it is built on to the procedure", async () => {
    const deletePost = symbolNamed(await scanWorkspace(), "deletePost")

    expect(
      deletePost.effects.map((e) => [
        e.id,
        e.target,
        e.propagated === true ? e.derivedFrom : "local",
      ]),
    ).toEqual([
      ["db.write", "prisma.post.delete", "local"],
      ["db.read", "prisma.membership.findFirst", ["ts:src/server/trpc.ts#isAdmin"]],
      ["db.read", "prisma.session.findUnique", ["ts:src/server/trpc.ts#protectedProcedure"]],
    ])
  })

  it("puts the procedure in the base procedure's Slice when the base's effects change", async () => {
    const base = await scanWorkspace()
    await workspace.writeSource("src/server/trpc.ts", trpcFile("Promise.resolve(ctx.sessionId)"))
    const head = await scanWorkspace()

    const diff = diffIRs(base.ir, head.ir)

    expect(diff.slices.map((slice) => slice.members)).toEqual([
      ["ts:src/server/post.ts#deletePost", "ts:src/server/trpc.ts#protectedProcedure"],
    ])
  })

  it("leaves the procedure out of the Slice when only the base's guard changes", async () => {
    const sessionRead = "prisma.session.findUnique({ where: { id: ctx.sessionId } })"
    const base = await scanWorkspace()
    await workspace.writeSource("src/server/trpc.ts", trpcFile(sessionRead, ""))
    const head = await scanWorkspace()

    const diff = diffIRs(base.ir, head.ir)

    expect(diff.slices.map((slice) => slice.members)).toEqual([
      ["ts:src/server/trpc.ts#protectedProcedure"],
    ])
  })
})

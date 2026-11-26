import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { expressFrameworkPlugin } from "@aburi/framework-express"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffOfEditWith, scanWith } from "@aburi/test-harness"
import { onlyChange, symbolById, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"

const workspace = useScratchWorkspace("route-handler")

const lineup = {
  languages: [langTypescriptPlugin],
  frameworks: [expressFrameworkPlugin],
  effects: [prismaEffectsPlugin],
}

const scanWorkspace = () => scanWith(workspace.root, lineup)

describe("scan — an Express route whose handler writes to a database", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/app.ts",
      [
        'import express from "express"',
        'import { PrismaClient } from "@prisma/client"',
        "",
        "const app = express()",
        "const prisma = new PrismaClient()",
        "",
        'app.post("/users", async (req, res) => {',
        "  const user = await prisma.user.create({ data: req.body })",
        "  res.json(user)",
        "})",
        "",
        'app.get("/users", async (req, res) => {',
        "  res.json(await prisma.user.findMany())",
        "})",
        "",
      ].join("\n"),
    )
  })

  it("puts each route's effect on the route that performs it", async () => {
    const result = await scanWorkspace()
    const read = symbolById(result, "ts:src/app.ts#app__get__$users__d0")
    const write = symbolById(result, "ts:src/app.ts#app__post__$users__d0")

    expect(write.extKind).toBe("framework:express:route")
    expect(read.effects.map((e) => e.id)).toEqual(["db.read"])
    expect(write.effects.map((e) => e.id)).toEqual(["db.write"])
  })

  it("gives the two routes different logic fingerprints", async () => {
    const result = await scanWorkspace()
    const read = symbolById(result, "ts:src/app.ts#app__get__$users__d0")
    const write = symbolById(result, "ts:src/app.ts#app__post__$users__d0")

    expect(read.fingerprint.logic).not.toBe(write.fingerprint.logic)
  })

  it("leaves the effect on the registration rather than moving it", async () => {
    const result = await scanWorkspace()

    expect(result.ir.stats.effectPropagation.symbolsWithPropagatedEffects).toBe(0)
  })
})

describe("scan — an Express route that names its handler", () => {
  const ROUTE = "ts:src/app.ts#router__get__$users__d0"
  const app = (handler: string) =>
    [
      'import express from "express"',
      'import { requireAdmin } from "./guards"',
      'import { listUsers, purgeUsers } from "./users"',
      "",
      "export const router = express.Router()",
      "",
      `router.get("/users", requireAdmin, ${handler})`,
      "",
    ].join("\n")

  beforeEach(async () => {
    await workspace.writeSource(
      "src/users.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        'import type { Request, Response } from "express"',
        "",
        "const prisma = new PrismaClient()",
        "",
        "export async function listUsers(req: Request, res: Response) {",
        "  res.json(await prisma.user.findMany())",
        "}",
        "",
        "export async function purgeUsers(req: Request, res: Response) {",
        "  await prisma.user.deleteMany()",
        "  res.sendStatus(204)",
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/guards.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        'import type { NextFunction, Request, Response } from "express"',
        "",
        "const prisma = new PrismaClient()",
        "",
        "export async function requireAdmin(req: Request, res: Response, next: NextFunction) {",
        '  await prisma.membership.findFirst({ where: { role: "admin" } })',
        "  next()",
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource("src/app.ts", app("listUsers"))
  })

  it("carries the effects of its middleware and handler to the route", async () => {
    const route = symbolById(await scanWorkspace(), ROUTE)

    expect(
      route.effects.map((e) => [e.id, e.target, e.propagated === true && e.derivedFrom]),
    ).toEqual([
      ["db.read", "prisma.membership.findFirst", ["ts:src/guards.ts#requireAdmin"]],
      ["db.read", "prisma.user.findMany", ["ts:src/users.ts#listUsers"]],
    ])
  })

  it("reports a handler swapped for one that writes as a logic change bringing the write", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      "src/app.ts",
      app("listUsers"),
      app("purgeUsers"),
    )

    const change = onlyChange(diff)

    expect(change.after.id).toBe(ROUTE)
    expect(change.delta).toMatchObject({
      logicChanged: true,
      effects: { added: [{ id: "db.write", target: "prisma.user.deleteMany" }] },
    })
  })
})

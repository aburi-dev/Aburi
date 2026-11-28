import { drizzleEffectsPlugin } from "@aburi/effects-drizzle"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"

const workspace = useScratchWorkspace("two-orm-effects")

describe("scan — a file that moves rows from Prisma to Drizzle", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/move.ts",
      [
        `import { PrismaClient } from "@prisma/client"`,
        `import { drizzle } from "drizzle-orm/node-postgres"`,
        `import { integer, pgTable, text } from "drizzle-orm/pg-core"`,
        ``,
        `const users = pgTable("users", { id: integer("id"), name: text("name") })`,
        `const prisma = new PrismaClient()`,
        `const db = drizzle(process.env.DATABASE_URL ?? "")`,
        ``,
        `export async function moveUser(id: number) {`,
        `  const user = await prisma.user.findUnique({ where: { id } })`,
        `  await db.insert(users).values({ id, name: user?.name ?? "" })`,
        `  await prisma.user.update({ where: { id }, data: { migrated: true } })`,
        `  await prisma.user.delete({ where: { id } })`,
        `}`,
        ``,
      ].join("\n"),
    )
  })

  it.each([
    ["Prisma", [prismaEffectsPlugin, drizzleEffectsPlugin]],
    ["Drizzle", [drizzleEffectsPlugin, prismaEffectsPlugin]],
  ])("gives each call to its own ORM at high, with %s's plugin asked first", async (_, effects) => {
    const result = await scanWith(workspace.root, { languages: [langTypescriptPlugin], effects })

    expect(
      symbolNamed(result, "moveUser").effects.map((e) => [e.target, e.plugin, e.confidence]),
    ).toEqual([
      ["prisma.user.findUnique", "effects-prisma", "high"],
      ["db.insert", "effects-drizzle", "high"],
      ["prisma.user.update", "effects-prisma", "high"],
      ["prisma.user.delete", "effects-prisma", "high"],
    ])
  })
})

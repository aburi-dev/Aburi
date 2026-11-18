import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffOfEditWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("reordered-effects")

function settle(...writes: string[]): string {
  return [
    'import { PrismaClient } from "@prisma/client"',
    "const prisma = new PrismaClient()",
    "",
    "export async function settle(id: string) {",
    ...writes.map((write) => `  ${write}`),
    "}",
    "",
  ].join("\n")
}

describe("scan + diff — two writes swapped", () => {
  it.each([
    [
      "on two lines",
      settle(
        "await prisma.account.update({ where: { id } })",
        "await prisma.audit.create({ data: { id } })",
      ),
      settle(
        "await prisma.audit.create({ data: { id } })",
        "await prisma.account.update({ where: { id } })",
      ),
    ],
    [
      "on one line",
      settle(
        "await prisma.account.update({ where: { id } }); await prisma.audit.create({ data: { id } })",
      ),
      settle(
        "await prisma.audit.create({ data: { id } }); await prisma.account.update({ where: { id } })",
      ),
    ],
  ])("report a logic change that names the reorder %s", async (_label, before, after) => {
    await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
    const { diff } = await diffOfEditWith(
      workspace,
      { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] },
      "src/settle.ts",
      before,
      after,
    )

    expect(diff.symbols).toMatchObject([
      {
        status: "changed",
        after: { id: "ts:src/settle.ts#settle" },
        delta: {
          logicChanged: true,
          effectsReordered: true,
          effects: { added: [], removed: [], modified: [] },
        },
      },
    ])
  })
})

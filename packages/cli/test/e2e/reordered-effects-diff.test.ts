import { readFile } from "node:fs/promises"
import { commitAll, gitTestEnv, initRepository, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { EXIT } from "../../src"
import { defaultOutput } from "../workspace"
import { removeWorktreeTempDirs, runBin, useBuiltBin } from "./bin"

const workspace = useScratchWorkspace("reordered-effects")

const settle = (...writes: string[]) =>
  [
    'import { PrismaClient } from "@prisma/client"',
    "const prisma = new PrismaClient()",
    "",
    "export async function settle(id: string) {",
    ...writes.map((write) => `  ${write}`),
    "}",
    "",
  ].join("\n")

const ACCOUNT = "await prisma.account.update({ where: { id } })"
const AUDIT = "await prisma.audit.create({ data: { id } })"

useBuiltBin()

beforeEach(async () => {
  await workspace.writeSource("package.json", '{"name":"api","private":true}\n')
  await workspace.writeSource(
    "aburi.json",
    '{"languages":["lang-typescript"],"effects":["effects-prisma"]}\n',
  )
  await workspace.writeSource("src/settle.ts", settle(ACCOUNT, AUDIT))
  await initRepository(workspace.root)
  await commitAll(workspace.root, "c1")
  await workspace.writeSource("src/settle.ts", settle(AUDIT, ACCOUNT))
  await commitAll(workspace.root, "c2")
  return () => removeWorktreeTempDirs(workspace.root)
})

describe("aburi diff — two writes swapped", () => {
  it("reports a logic change naming the reorder, which a logic gate stops", async () => {
    const run = await runBin(
      workspace.root,
      ["diff", "HEAD~1..HEAD", "--fail-on", "logic-changed"],
      gitTestEnv(workspace.root),
    )
    expect(run.code, run.stderr).toBe(EXIT.GATE)

    const report = await readFile(defaultOutput(workspace.root, "diff.md"), "utf8")
    expect(report).toContain(
      "- effects reordered: db.write `prisma.account.update`, db.write `prisma.audit.create` → db.write `prisma.audit.create`, db.write `prisma.account.update`",
    )
    expect(report).not.toContain("no field-level detail")
  })
})

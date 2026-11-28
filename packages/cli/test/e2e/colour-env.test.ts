import { commitAll, gitTestEnv, useScratchWorkspace } from "@aburi/test-support"
import { afterEach, describe, expect, it } from "vitest"
import { writeStubRepository } from "../stub-language"
import { removeWorktreeTempDirs, runBin, useBuiltBin } from "./bin"

const workspace = useScratchWorkspace("colour-env")

useBuiltBin()

afterEach(async () => {
  await removeWorktreeTempDirs(workspace.root)
})

const NODE_WARNING = /\(node:\d+\)|--trace-warnings/

describe("FORCE_COLOR beside NO_COLOR or NODE_DISABLE_COLORS", () => {
  it.each([
    ["a scan on parser workers", ["scan", "--concurrency", "2", "--output-dir", "out"]],
    ["a ref diff, whose base scans on a worker", ["diff", "HEAD~1..HEAD", "--output-dir", "out"]],
  ])("colours %s and puts none of Node's warnings on stderr", async (_, argv) => {
    await writeStubRepository(workspace.root, {
      base: ["ok.stub"],
      head: ["ok.stub", "warn.stub"],
    })
    await commitAll(workspace.root, "head")

    const run = await runBin(
      workspace.root,
      argv,
      gitTestEnv(workspace.root, { FORCE_COLOR: "1", NO_COLOR: "1", NODE_DISABLE_COLORS: "1" }),
    )

    expect(run.stderr).not.toMatch(NODE_WARNING)
    expect(run.stderr).toContain("\u001b[33m⚠")
  })

  it("leaves stderr empty for --version", async () => {
    const run = await runBin(
      workspace.root,
      ["--version"],
      gitTestEnv(workspace.root, { FORCE_COLOR: "1", NO_COLOR: "1" }),
    )

    expect([run.code, run.stderr]).toEqual([0, ""])
  })
})

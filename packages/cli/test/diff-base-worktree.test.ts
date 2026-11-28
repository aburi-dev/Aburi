import { appendFile, mkdir, readdir, readFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import {
  commitAll,
  errorFrom,
  git,
  initRepository,
  recordingLogger,
  useScratchWorkspace,
} from "@aburi/test-support"
import type { DiffResult } from "@aburi/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CliError, EXIT, runDiff } from "../src"
import { fakeGit, gitOutput } from "./git"
import {
  TYPESCRIPT,
  writeConfig,
  writeDiffWorkspace,
  writeFileAt,
  writePackageJson,
} from "./workspace"

const workspace = useScratchWorkspace("diff-base-worktree")

afterEach(() => {
  vi.unstubAllEnvs()
})

function tempDirectoryAt(directory: string): void {
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, directory)
}

/** A TypeScript repository whose one commit declares `one()`. */
async function repository(directory: string, manifest = true): Promise<void> {
  await initRepository(directory)
  await writeDiffWorkspace(
    directory,
    { "src/one.ts": "export function one(): number { return 1 }\n" },
    { manifest },
  )
  await commitAll(directory, "c1")
}

async function addFunction(directory: string, file: string, name: string): Promise<void> {
  await appendFile(resolve(directory, file), `export function ${name}(): number { return 2 }\n`)
  await commitAll(directory, `add ${name}`)
}

async function diffIn(cwd: string, refSpec: string, failOn = "added") {
  const log = recordingLogger()
  const report = await runDiff({
    cwd,
    refSpec,
    outputDir: resolve(workspace.root, "out"),
    failOn,
    warn: log.warn,
  })
  const diff = JSON.parse(await readFile(report.diffJsonPath ?? "", "utf8")) as DiffResult
  return { report, diff, warnings: log.warnings }
}

const UNCOMMITTED = "export function uncommitted(): number { return 3 }\n"

async function worktreesOf(directory: string): Promise<string[]> {
  const listing = await git(["worktree", "list", "--porcelain"], directory)
  return listing.split("\n").filter((line) => line.startsWith("worktree "))
}

/** A commit past the one checked out, so the head names a revision Aburi checks out apart. */
async function checkOutBefore(directory: string): Promise<string> {
  await git(["commit", "-q", "--allow-empty", "-m", "later"], directory)
  await git(["checkout", "-q", "HEAD~1"], directory)
  return "HEAD..main"
}

const addedOne = (id: string) => ({
  clause: { token: "added", threshold: null },
  observed: 1,
  symbols: [id],
  scope: "all",
})

describe("aburi diff — where the base revision is checked out", () => {
  it("diffs a linked worktree kept inside the main checkout, not the main checkout", async () => {
    const main = resolve(workspace.root, "demo")
    await repository(main)
    await git(["worktree", "add", "-q", "-b", "feat", ".worktrees/feat"], main)
    const feat = resolve(main, ".worktrees", "feat")
    await addFunction(feat, "src/feat.ts", "featOnly")

    const { report, warnings } = await diffIn(feat, "main..feat")

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(report.triggered).toEqual(addedOne("ts:src/feat.ts#featOnly"))
    expect(report.faultedScans).toEqual([])
    expect(warnings).toEqual([])
  })

  it.each([".claude/worktrees/feat", "worktrees/feat"])(
    "leaves a linked worktree at %s out of the main checkout's scan",
    async (at) => {
      const main = resolve(workspace.root, "demo")
      await repository(main)
      await git(["worktree", "add", "-q", "-b", "feat", at], main)
      await addFunction(resolve(main, at), "src/feat.ts", "featOnly")

      const { report, warnings } = await diffIn(main, "HEAD..HEAD")

      expect(report.summaryLine).toBe("+0 -0 ~0 ↔0 ⤴0")
      expect(report.exitCode).toBe(EXIT.SUCCESS)
      expect(warnings).toEqual([])
    },
  )

  it("diffs a repository nested in another without reading every Symbol as moved", async () => {
    await initRepository(workspace.root)
    const inner = resolve(workspace.root, "demo")
    await repository(inner)
    await addFunction(inner, "src/one.ts", "two")

    const { report, warnings } = await diffIn(inner, "HEAD~1..HEAD", "moved")

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings).toEqual([])
  })

  it("scans the base revision when the temporary directory is inside the repository", async () => {
    await repository(workspace.root)
    await addFunction(workspace.root, "src/one.ts", "two")
    const inside = resolve(workspace.root, ".tmp")
    await mkdir(inside)
    tempDirectoryAt(inside)

    const { report, warnings } = await diffIn(workspace.root, "HEAD~1..HEAD")

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(report.triggered).toEqual(addedOne("ts:src/one.ts#two"))
    expect(report.faultedScans).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe("aburi diff — which tree the head side is", () => {
  it("checks a head revision out of its own when another is checked out, and removes it after", async () => {
    await repository(workspace.root)
    await addFunction(workspace.root, "src/one.ts", "two")
    await git(["checkout", "-q", "HEAD~1"], workspace.root)
    await appendFile(resolve(workspace.root, "src/one.ts"), UNCOMMITTED)

    const { report, warnings } = await diffIn(workspace.root, "HEAD..main")

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(report.triggered).toEqual(addedOne("ts:src/one.ts#two"))
    expect(warnings).toEqual([])
    expect(await worktreesOf(workspace.root)).toHaveLength(1)
  })

  it.each([
    ["HEAD", "HEAD"],
    ["a branch", "main"],
    ["an annotated tag", "v2"],
  ])(
    "reads the working tree, uncommitted edits included, for %s naming the commit checked out",
    async (_, head) => {
      await repository(workspace.root)
      await addFunction(workspace.root, "src/one.ts", "two")
      await git(["tag", "-a", "-m", "v2", "v2"], workspace.root)
      await appendFile(resolve(workspace.root, "src/one.ts"), UNCOMMITTED)

      const { report, warnings } = await diffIn(workspace.root, `HEAD~1..${head}`)

      expect(report.summaryLine).toBe("+2 -0 ~0 ↔0 ⤴0")
      expect(warnings).toEqual([])
    },
  )
})

describe("aburi diff — the base checkout describes the same Components as the head", () => {
  const headIsTheWorkingTree = async (): Promise<string> => "HEAD..HEAD"

  it.each([
    ["only the checkout directory differs", "demo", "", headIsTheWorkingTree],
    [
      "the workspace is named like the run's own output directories",
      "base-out",
      "",
      headIsTheWorkingTree,
    ],
    ["the command ran in a subdirectory of the workspace", "demo", "src", headIsTheWorkingTree],
    ["the head is checked out apart", "demo", "", checkOutBefore],
    ["the head is checked out apart, from a subdirectory", "demo", "src", checkOutBefore],
  ])("reports no Component change when %s", async (_, name, below, refSpecFor) => {
    const root = resolve(workspace.root, name)
    await repository(root, false)
    const refSpec = await refSpecFor(root)

    const { diff, warnings, report } = await diffIn(resolve(root, below), refSpec)

    expect(diff.summary).toMatchObject({ componentsAdded: 0, componentsRemoved: 0 })
    expect(warnings).toEqual([])
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("checks a workspace named `@` out under a name git can spell, so the scan's own error surfaces", async () => {
    const root = resolve(workspace.root, "@")
    await repository(root, false)

    const error = await errorFrom(CliError, () => diffIn(root, "HEAD..HEAD"))

    expect(error.message).toMatch(/Cannot derive a Component id from directory name/)
  })
})

describe("aburi diff — cleaning up the checkouts", () => {
  it.each<[string, (directory: string) => Promise<string>]>([
    [
      "the base scan fails",
      async (directory) => {
        await writePackageJson(directory, { name: "demo", private: true })
        return "HEAD..HEAD"
      },
    ],
    [
      "the scan of a head checked out apart fails",
      async (directory) => {
        await git(["checkout", "-q", "HEAD~1"], directory)
        return "HEAD..main"
      },
    ],
  ])("removes every worktree and the temporary directory when %s", async (_, refSpecFor) => {
    const demo = resolve(workspace.root, "demo")
    await repository(demo)
    await writeFileAt(demo, "package.json", '{ "name": "broken", }')
    await commitAll(demo, "break the manifest")
    const refSpec = await refSpecFor(demo)
    const temp = resolve(workspace.root, "tmp")
    await mkdir(temp)
    tempDirectoryAt(temp)

    await expect(diffIn(demo, refSpec)).rejects.toThrow(/Failed to parse JSON/)

    expect(await worktreesOf(demo)).toHaveLength(1)
    expect(await readdir(temp)).toEqual([])
  })

  it.each<[string, "base" | "head", string, string[]]>([
    ["the base's", "base", "abc", []],
    ["a head's, checked out apart once the base was", "head", "def", ["base"]],
  ])(
    "removes no worktree that `worktree add` never created, when %s fails",
    async (_, refused, checkedOut, removed) => {
      const sideOf = (worktreeDir: string | undefined): string =>
        basename(dirname(worktreeDir ?? ""))
      const removedSides: string[] = []
      const { runner } = fakeGit({
        handlers: {
          "rev-parse --verify": (args) =>
            gitOutput(args[2] === "HEAD^{commit}" ? `${checkedOut}\n` : "abc\n"),
          "worktree add": (args) => {
            if (sideOf(args[3]) === refused)
              throw new Error("fatal: could not create work tree dir")
            return gitOutput()
          },
          "worktree remove": (args) => {
            removedSides.push(sideOf(args[3]))
            return gitOutput()
          },
        },
      })
      const temp = resolve(workspace.root, "tmp")
      await mkdir(temp)
      tempDirectoryAt(temp)
      const log = recordingLogger()

      const error = await errorFrom(Error, () =>
        runDiff({ cwd: workspace.root, refSpec: "main..HEAD", git: runner, warn: log.warn }),
      )

      expect(error.message).toMatch(/could not create work tree dir/)
      expect(removedSides).toEqual(removed)
      expect(log.warnings.join("\n")).not.toContain("git worktree cleanup failed")
      expect(await readdir(temp)).toEqual([])
    },
  )

  it("refuses, as a bug in Aburi, a base scan that roots outside its worktree", async () => {
    const demo = resolve(workspace.root, "demo")
    await mkdir(resolve(demo, ".git"), { recursive: true })
    await writeConfig(demo, TYPESCRIPT)
    const outer = resolve(workspace.root, "outer")
    await writeFileAt(outer, "pnpm-workspace.yaml", "packages: []\n")
    await mkdir(resolve(outer, "tmp"))
    tempDirectoryAt(resolve(outer, "tmp"))
    const worktrees: string[] = []
    const { runner } = fakeGit({
      onWorktreeAdd: async (worktreeDir) => {
        worktrees.push(worktreeDir)
        await writeFileAt(worktreeDir, "src/one.ts", "export function one() { return 1 }\n")
      },
    })

    const error = await errorFrom(CliError, () =>
      runDiff({ cwd: demo, refSpec: "main..HEAD", git: runner, warn: () => {} }),
    )

    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain(
      `Internal error while scanning base ref "main": the scan rooted at ${outer} instead of the worktree ${worktrees[0]}`,
    )
  })
})

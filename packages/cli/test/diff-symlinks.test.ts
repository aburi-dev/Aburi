import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  commitAll,
  git,
  initRepository,
  makeIR,
  makeSymbol,
  recordingLogger,
  useScratchWorkspace,
} from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"
import { describeLinksReadAsSource, linksReadAsSource, plainFileLinks } from "../src/git/symlinks"
import { writeDiffWorkspace, writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("diff-symlinks")

/** Two a scan reads as source once they are plain files, one named outside ASCII, and two it never reads. */
const LINKS: readonly (readonly [string, string])[] = [
  ["src/linked.ts", "main.ts"],
  ["src/café.ts", "main.ts"],
  ["docs/guide", "../README.md"],
  ["vendor/lib", "../node_modules/lib"],
]
const READ = ["src/café.ts", "src/linked.ts"]

const BASE_REMEDY =
  "git writes a link that way while core.symlinks is false; set it to true where links can be created (on Windows, with Developer Mode)."
const HEAD_REMEDY =
  "Set core.symlinks to true where links can be created (on Windows, with Developer Mode), then check them out again with `git checkout -- <path>`, " +
  "since a change to the setting leaves the files already checked out as they are."

const readAsSource = (count: number, listing: string, remedy: string) =>
  `${count} symbolic link(s) checked out as plain files holding their targets were read as source, ` +
  `where a scan passes over a link: ${listing}. ${remedy}`

const baseWarning = (paths: readonly string[]) =>
  `⚠ base ref "HEAD~1": ${readAsSource(paths.length, paths.join(", "), BASE_REMEDY)}`
const headWarning = (paths: readonly string[]) =>
  `⚠ head (working tree): ${readAsSource(paths.length, paths.join(", "), HEAD_REMEDY)}`

async function repository(symlinks: "true" | "false"): Promise<string> {
  const demo = resolve(workspace.root, "demo")
  await initRepository(demo)
  await git(["config", "core.symlinks", symlinks], demo)
  await writeDiffWorkspace(demo, { "src/main.ts": "export function main(): number { return 1 }\n" })
  await commitAll(demo, "c1")
  return demo
}

/**
 * Written to the index, so no fixture needs the privilege to create a link, then checked out
 * under whatever `core.symlinks` the repository has.
 */
async function commitLinks(repo: string, links: readonly (readonly [string, string])[]) {
  for (const [path, target] of links) {
    const blob = resolve(workspace.root, "link-target")
    await writeFile(blob, target)
    const sha = (await git(["hash-object", "-w", blob], repo)).trim()
    await git(["update-index", "--add", "--cacheinfo", `120000,${sha},${path}`], repo)
  }
  await git(["commit", "-q", "-m", "links"], repo)
  await git(["checkout", "--", "."], repo)
}

async function changeMain(repo: string): Promise<void> {
  await writeFileAt(repo, "src/main.ts", "export function main(): number { return 2 }\n")
  await commitAll(repo, "change main")
}

async function diffIn(cwd: string) {
  const log = recordingLogger()
  const report = await runDiff({
    cwd,
    refSpec: "HEAD~1..HEAD",
    outputDir: resolve(cwd, "out"),
    warn: log.warn,
  })
  return { exitCode: report.exitCode, warnings: log.warnings }
}

describe("aburi diff over symbolic links git checked out as plain files", () => {
  it.each([
    ["the repository root", ""],
    ["a subdirectory", "src"],
  ])("names on each side the links its scan read as source, run from %s", async (_, below) => {
    const demo = await repository("false")
    await commitLinks(demo, LINKS)
    await changeMain(demo)

    const { exitCode, warnings } = await diffIn(resolve(demo, below))

    expect(exitCode).toBe(EXIT.SUCCESS)
    expect(warnings).toEqual([baseWarning(READ), headWarning(READ)])
  })

  it.each(["false", "true"])(
    "names the head's alone for links it added, checked out as files, with core.symlinks %s at the run",
    async (setting) => {
      const demo = await repository("false")
      await commitLinks(demo, LINKS)
      await git(["config", "core.symlinks", setting], demo)

      const { exitCode, warnings } = await diffIn(demo)

      expect(exitCode).toBe(EXIT.SUCCESS)
      expect(warnings).toEqual([headWarning(READ)])
    },
  )

  // Creating a link on Windows needs a privilege an ordinary test run does not have.
  it.skipIf(process.platform === "win32")(
    "says nothing where git checked the links out as links",
    async () => {
      const demo = await repository("true")
      await commitLinks(demo, LINKS)
      await changeMain(demo)

      const { exitCode, warnings } = await diffIn(demo)

      expect(exitCode).toBe(EXIT.SUCCESS)
      expect(warnings).toEqual([])
    },
  )
})

describe("plainFileLinks", () => {
  it("keeps the tracked links whose checkout is a regular file", async () => {
    const root = resolve(workspace.root, "checkout")
    await writeFileAt(root, "file.ts", "main.ts")
    await writeFileAt(root, "tracked.ts", "export {}\n")
    await mkdir(resolve(root, "directory.ts"))
    const listing = [
      "120000 aaa 0\tfile.ts",
      "120000 bbb 0\tdirectory.ts",
      "120000 ccc 0\tgone.ts",
      "100644 ddd 0\ttracked.ts",
      "",
    ].join("\0")

    expect(await plainFileLinks(listing, root)).toEqual(["file.ts"])
  })
})

describe("linksReadAsSource", () => {
  it("keeps the links a Symbol came from, as git spells them, though the IR composes the name", () => {
    const decomposed = "src/café.ts"
    const ir = makeIR({
      symbols: ["src/café.ts", "src/linked.ts", "src/main.ts"].map((file) =>
        makeSymbol({ id: `ts:${file}#<module>`, name: "<module>", kind: "module" }),
      ),
    })

    expect(linksReadAsSource(["docs/guide", decomposed, "src/linked.ts"], ir)).toEqual([
      decomposed,
      "src/linked.ts",
    ])
  })
})

describe("describeLinksReadAsSource", () => {
  it("lists ten links, then the count of the rest", () => {
    const paths = Array.from(
      { length: 12 },
      (_, at) => `src/link-${String(at + 1).padStart(2, "0")}.ts`,
    )

    expect(describeLinksReadAsSource("base", paths)).toBe(
      readAsSource(12, `${paths.slice(0, 10).join(", ")}, and 2 more`, BASE_REMEDY),
    )
  })
})

import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { commitAll, gitTestEnv, initRepository, useScratchWorkspace } from "@aburi/test-support"
import { expect, it } from "vitest"

const run = promisify(execFile)
const changesetBin = createRequire(import.meta.url).resolve("@changesets/cli/bin.js")
const changelogModule = fileURLToPath(new URL("../src/index.mjs", import.meta.url))

const workspace = useScratchWorkspace("changelog")

function manifest(fields) {
  return `${JSON.stringify(fields, null, 2)}\n`
}

function changeset(packageName, summary) {
  return `---\n"${packageName}": patch\n---\n\n${summary}\n`
}

async function bullets(path) {
  return (await readFile(path, "utf8")).split("\n").filter((line) => /^\s*- /.test(line))
}

it("writes a dependent's dependency bumps in one line and each changeset of the bumped package under its commit", async () => {
  const root = workspace.root
  await workspace.writeSource("package.json", manifest({ name: "scratch", private: true }))
  await workspace.writeSource("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n')
  await workspace.writeSource(
    "packages/lib/package.json",
    manifest({ name: "lib", version: "1.0.0" }),
  )
  await workspace.writeSource(
    "packages/app/package.json",
    manifest({ name: "app", version: "1.0.0", dependencies: { lib: "workspace:*" } }),
  )
  await workspace.writeSource(
    ".changeset/config.json",
    manifest({
      changelog: changelogModule,
      commit: false,
      access: "restricted",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      fixed: [],
      linked: [],
      ignore: [],
    }),
  )
  await initRepository(root)
  await commitAll(root, "workspace")
  await workspace.writeSource(
    ".changeset/first.md",
    changeset("lib", "Parse empty input\n\nAn empty file used to throw."),
  )
  await commitAll(root, "first change")
  await workspace.writeSource(".changeset/second.md", changeset("lib", "Trim trailing blanks"))
  await workspace.writeSource(".changeset/third.md", changeset("lib", "Keep tabs"))
  await commitAll(root, "second and third change")

  await run(process.execPath, [changesetBin, "version"], { cwd: root, env: gitTestEnv(root) })

  expect(await bullets(join(root, "packages/app/CHANGELOG.md"))).toEqual([
    "- Updated dependencies: `lib@1.0.1`",
  ])
  const lib = await bullets(join(root, "packages/lib/CHANGELOG.md"))
  expect(lib).toHaveLength(3)
  expect(lib).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^- [0-9a-f]{7}: Parse empty input$/),
      expect.stringMatching(/^- [0-9a-f]{7}: Trim trailing blanks$/),
      expect.stringMatching(/^- [0-9a-f]{7}: Keep tabs$/),
    ]),
  )
  await expect(readFile(join(root, "packages/lib/CHANGELOG.md"), "utf8")).resolves.toContain(
    "\n  An empty file used to throw.\n",
  )
})

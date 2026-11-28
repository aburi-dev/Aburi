import { makeSymbol, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { runInit } from "../src"
import { packagesInNoComponent } from "../src/commands/scan-components"
import {
  scanSaying,
  TYPESCRIPT,
  writeConfig,
  writeFileAt,
  writeMonorepo,
  writeMonorepoPackage,
} from "./workspace"

const workspace = useScratchWorkspace("declared-components")

async function writeThreePackages(): Promise<void> {
  await writeMonorepo(workspace.root)
  await writeMonorepoPackage(workspace.root, "b", ["fb"])
  await writeMonorepoPackage(workspace.root, "c", ["fc", "gc"])
}

const component = (id: string, root = `pkgs/${id}`) => ({ id, roots: [root] })

const LEFT_OUT =
  "A declared components list is the whole set: add each package to it, leave its files out with ignore, or remove components to have every package detected."

describe("aburi scan — a workspace package the declared components leave out", () => {
  it("names a package added after `aburi init` wrote the components, with its Symbols", async () => {
    await writeMonorepo(workspace.root)
    await writeMonorepoPackage(workspace.root, "b", ["fb"])
    await runInit({ cwd: workspace.root })
    await writeMonorepoPackage(workspace.root, "c", ["fc", "gc"])

    expect((await scanSaying(workspace.root)).warnings).toEqual([
      `⚠ 1 workspace package(s) are in none of the components the config declares, so their Symbols count towards no Component: pkgs/c (2 Symbols). ${LEFT_OUT}`,
    ])
  })

  it.each<[string, Record<string, unknown>]>([
    ["detects the components", {}],
    ["declares every package", { components: [component("app"), component("b"), component("c")] }],
    [
      "leaves out only a package whose files it ignores",
      { components: [component("app"), component("b")], ignore: ["pkgs/c/**"] },
    ],
    [
      "declares a root inside the package it leaves the rest of",
      { components: [component("app"), component("b"), component("core", "pkgs/c/src/core")] },
    ],
  ])("says nothing when the config %s", async (_, config) => {
    await writeThreePackages()
    await writeFileAt(workspace.root, "pkgs/c/src/core/a.ts", "export function core() {}\n")
    await writeConfig(workspace.root, { ...TYPESCRIPT, ...config })

    expect((await scanSaying(workspace.root)).warnings).toEqual([])
  })
})

const symbolIn = (file: string, component: string | null = null) =>
  makeSymbol({ id: `ts:${file}#f`, name: "f", component })

describe("packagesInNoComponent", () => {
  it.each([
    {
      case: "counts a Symbol under the deepest root holding its file",
      roots: ["packages/a", "packages/a/nested"],
      files: ["packages/a/x.ts", "packages/a/nested/y.ts", "packages/a/nested/z.ts"],
      counted: [
        { root: "packages/a", symbols: 1 },
        { root: "packages/a/nested", symbols: 2 },
      ],
    },
    {
      case: "reads a root as a directory, not as a prefix of a longer name",
      roots: ["packages/a", "packages/ab"],
      files: ["packages/ab/x.ts"],
      counted: [{ root: "packages/ab", symbols: 1 }],
    },
    {
      case: "gives `.` only what no other root holds",
      roots: [".", "x"],
      files: ["x/index.ts", "tools/y.ts"],
      counted: [
        { root: ".", symbols: 1 },
        { root: "x", symbols: 1 },
      ],
    },
    {
      case: "leaves out a root no Symbol came from, and follows the order of the roots",
      roots: ["packages/z", "packages/b", "packages/a"],
      files: ["packages/a/x.ts", "packages/z/y.ts"],
      counted: [
        { root: "packages/z", symbols: 1 },
        { root: "packages/a", symbols: 1 },
      ],
    },
  ])("$case", ({ roots, files, counted }) => {
    expect(
      packagesInNoComponent(
        files.map((file) => symbolIn(file)),
        roots,
      ),
    ).toEqual(counted)
  })

  it("skips a Symbol a Component holds", () => {
    expect(packagesInNoComponent([symbolIn("packages/a/x.ts", "a")], ["packages/a"])).toEqual([])
  })
})

import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { runInit, runScan } from "../src"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("declared-components")

async function writePackage(name: string, functions: readonly string[]): Promise<void> {
  await writePackageJson(`${workspace.root}/packages/${name}`, { name, version: "1.0.0" })
  const source = functions.map((fn) => `export function ${fn}() { return 1 }\n`).join("")
  await writeFileAt(workspace.root, `packages/${name}/src/index.ts`, source)
}

async function pnpmWorkspace(): Promise<void> {
  await writePackageJson(workspace.root, { name: "root", private: true })
  await writeFileAt(workspace.root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n")
  await writePackage("a", ["fa"])
  await writePackage("b", ["fb"])
}

async function scanWarnings(): Promise<string[]> {
  const log = recordingLogger()
  await runScan({ cwd: workspace.root, outputDir: "out", incidents: { warn: log.warn } })
  return log.warnings
}

const LEFT_OUT =
  "A declared components list is the whole set: add each package to it, or remove components to have every package detected."

describe("aburi scan — a workspace package the declared components leave out", () => {
  it("names a package added after `aburi init` wrote the components, with its Symbols", async () => {
    await pnpmWorkspace()
    await runInit({ cwd: workspace.root })
    await writePackage("c", ["fc", "gc"])

    expect(await scanWarnings()).toEqual([
      `⚠ 1 workspace package(s) are in none of the components the config declares, so their Symbols count towards no Component: packages/c (2 Symbols). ${LEFT_OUT}`,
    ])
  })

  it.each<[string, Record<string, unknown>]>([
    ["detects the components", {}],
    [
      "declares every package",
      {
        components: [
          { id: "a", roots: ["packages/a"] },
          { id: "b", roots: ["packages/b"] },
        ],
      },
    ],
    [
      "leaves out only a package whose files it ignores",
      { components: [{ id: "a", roots: ["packages/a"] }], ignore: ["packages/b/**"] },
    ],
  ])("says nothing when the config %s", async (_, config) => {
    await pnpmWorkspace()
    await writeConfig(workspace.root, { ...TYPESCRIPT, ...config })

    expect(await scanWarnings()).toEqual([])
  })
})

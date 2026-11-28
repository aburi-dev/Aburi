import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT } from "../src"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig, writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("workspace-manifest-faults")

const WORKSPACE: Readonly<Record<string, string>> = {
  "package.json": '{"name":"root","private":true}',
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "packages/a/package.json": '{"name":"a"}',
  "packages/a/src/index.ts": "export const x = 1\n",
}

const COMMANDS = [
  ["scan", ["scan", "--format", "json"], "Failed to resolve components: "],
  ["init", ["init", "--force"], "Failed to detect components: "],
] as const

const FAULTS = [
  [
    "a workspace package's package.json",
    "packages/a/package.json",
    '{"name":"a",',
    "Failed to parse JSON at",
  ],
  ["the root package.json", "package.json", '{"name":"root",', "Failed to parse JSON at"],
  [
    "a pnpm-workspace.yaml that does not parse",
    "pnpm-workspace.yaml",
    "packages:\n  - [packages/*\n",
    "Failed to parse pnpm-workspace.yaml at",
  ],
  [
    "a pnpm-workspace.yaml whose entry is not a pattern",
    "pnpm-workspace.yaml",
    "packages:\n  - packages/*:\n",
    '"packages" in',
  ],
] as const

describe("a workspace manifest the reader wrote and the component search cannot read", () => {
  it.each(
    COMMANDS.flatMap(([command, argv, prefix]) =>
      FAULTS.map(
        ([fault, file, content, says]) =>
          [command, fault, argv, prefix, file, content, says] as const,
      ),
    ),
  )(
    "aburi %s reports %s as a config error",
    async (_command, _fault, argv, prefix, file, content, says) => {
      for (const [path, source] of Object.entries(WORKSPACE)) {
        await writeFileAt(workspace.root, path, path === file ? content : source)
      }
      await writeConfig(workspace.root, TYPESCRIPT)

      const { code, stderr } = await runCliIn(workspace.root, [...argv])

      expect(code, stderr).toBe(EXIT.INPUT_ERROR)
      expect(stderr).toContain(`${prefix}${says} `)
      expect(stderr).toContain(resolve(workspace.root, file))
    },
  )
})

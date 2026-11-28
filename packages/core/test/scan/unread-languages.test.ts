import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { detectComponents } from "../../src"
import { scanStubs } from "../fixtures/plugins"

const workspace = useScratchWorkspace("unread-languages")

const PNPM_WORKSPACE = { "pnpm-workspace.yaml": ["packages:", "  - packages/*"] }

function manifest(name: string): string[] {
  return [JSON.stringify({ name, version: "1.0.0" })]
}

function files(directory: string, extension: string, count: number): Record<string, string[]> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${directory}/f${i}${extension}`, ["x"]]),
  )
}

async function scanDetected() {
  const { components } = await detectComponents({ workspaceRoot: workspace.root })
  const result = await scanStubs(workspace.root, { components })
  return { result, languages: components.map((c) => [c.id, c.languages]) }
}

describe("scan — files of a language no loaded plugin reads", () => {
  it("names the Component that holds them, with how many, and counts them nowhere", async () => {
    await workspace.writeSources({
      ...PNPM_WORKSPACE,
      "packages/web/package.json": manifest("web"),
      "packages/web/src/a.stub": ["a"],
      "packages/ml/package.json": manifest("ml"),
      ...files("packages/ml/src", ".py", 10),
      ...files("packages/ml/tools", ".go", 12),
    })

    const { result, languages } = await scanDetected()

    expect(languages).toEqual([
      ["ml", ["go", "py"]],
      ["web", ["ts"]],
    ])
    expect(result.unreadLanguages).toEqual([
      { component: "ml", language: "go", files: 12 },
      { component: "ml", language: "py", files: 10 },
    ])
    expect([result.ir.stats.totalFiles, result.skipped]).toEqual([1, []])
  })

  it("passes over a language the census gives a Component with no file of it", async () => {
    await workspace.writeSources({
      ...PNPM_WORKSPACE,
      "packages/web/package.json": manifest("web"),
      "packages/web/src/a.stub": ["a"],
    })

    const { result, languages } = await scanDetected()

    expect(languages).toEqual([["web", ["ts"]]])
    expect(result.unreadLanguages).toEqual([])
  })

  it("passes over files of a language the census does not give the Component", async () => {
    await workspace.writeSources({
      ...PNPM_WORKSPACE,
      "packages/web/package.json": manifest("web"),
      ...files("packages/web/src", ".stub", 10),
      ...files("packages/web/scripts", ".py", 2),
    })

    const { result } = await scanDetected()

    expect(result.unreadLanguages).toEqual([])
  })

  it("passes over files .gitignore leaves out", async () => {
    await workspace.writeSources({
      ...PNPM_WORKSPACE,
      ".gitignore": ["packages/ml/src/"],
      "packages/ml/package.json": manifest("ml"),
      ...files("packages/ml/src", ".py", 10),
      ...files("packages/ml/tools", ".py", 10),
    })

    const { result } = await scanDetected()

    expect(result.unreadLanguages).toEqual([{ component: "ml", language: "py", files: 10 }])
  })
})

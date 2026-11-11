import { readdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_OUTPUT_DIRNAME, EXIT, OUTPUT_DIR_GITIGNORE } from "../src"
import { pathExists } from "../src/fs-probe"
import { removeOutputFileOpeningWith } from "../src/output-file"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig, writeFileAt } from "./workspace"

const refusing = vi.hoisted(() => ({ gitignores: 0 }))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      if (refusing.gitignores === 0 || !String(args[0]).endsWith(".gitignore")) {
        return actual.writeFile(...args)
      }
      refusing.gitignores -= 1
      return Promise.reject(
        Object.assign(new Error(`EACCES: permission denied, open '${String(args[0])}'`), {
          code: "EACCES",
        }),
      )
    },
    open: async (path: string) => {
      const handle = await actual.open(path)
      return {
        read: (buffer: Buffer, offset: number, length: number, position: number) =>
          handle.read(buffer, offset, Math.min(length, 3), position),
        close: () => handle.close(),
      }
    },
  }
})

const workspace = useScratchWorkspace("output-file")

describe("a file removed by its first line, on a filesystem that reads a few bytes at a time", () => {
  it.each([
    ["removes one that opens with that line", "# Component: beta\n\n**Name**: beta\n", []],
    ["keeps one whose first line goes on past it", "# Component: beta extra notes\n", ["beta.md"]],
  ])("%s", async (_, contents, left) => {
    const path = resolve(workspace.root, "beta.md")
    await writeFile(path, contents, "utf8")

    await removeOutputFileOpeningWith(
      { command: "scan", artefact: "the Markdown for component beta", path },
      "# Component: beta",
    )

    expect(await readdir(workspace.root)).toEqual(left)
  })
})

describe("the default output directory, when its .gitignore cannot be written", () => {
  it("ends the run and takes the directory back, so the next run that creates it ignores it", async () => {
    await writeConfig(workspace.root, TYPESCRIPT)
    await writeFileAt(workspace.root, "src/a.ts", "export function alpha() { return 1 }\n")
    const directory = resolve(workspace.root, DEFAULT_OUTPUT_DIRNAME)
    refusing.gitignores = 1

    const refused = await runCliIn(workspace.root, ["scan"])

    expect(refused.code).toBe(EXIT.RUNTIME)
    expect(refused.stderr).toContain(
      `aburi scan could not write the output directory's .gitignore to ${resolve(directory, ".gitignore")}: EACCES`,
    )
    expect(await pathExists(directory)).toBe(false)

    expect((await runCliIn(workspace.root, ["scan"])).code).toBe(EXIT.SUCCESS)
    expect(await readFile(resolve(directory, ".gitignore"), "utf8")).toBe(OUTPUT_DIR_GITIGNORE)
  })
})

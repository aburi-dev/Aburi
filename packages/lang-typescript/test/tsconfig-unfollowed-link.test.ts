import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { linkDirectory, recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it, vi } from "vitest"
import { langTypescriptPlugin } from "../src/index"

const UNFOLLOWED = join("node_modules", "@repo", "tsconfig", "base.json")

// Some volumes, such as certain RAM disks and network shares, refuse `realpath` where reads work.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    realpath: async (path: string) => {
      const real = await actual.realpath(path)
      if (!path.endsWith(UNFOLLOWED)) return real
      throw Object.assign(new Error(`EPERM: operation not permitted, realpath '${path}'`), {
        code: "EPERM",
      })
    },
  }
})

const workspace = useScratchWorkspace("tsconfig-unfollowed-link")

describe("the TypeScript import resolver — a link it cannot follow", () => {
  it("reads the config where it is written, and says the link was not followed", async () => {
    const at = (path: string) => join(workspace.root, path)
    await workspace.writeSource(
      "head/packages/tsconfig/base.json",
      JSON.stringify({ compilerOptions: { paths: { "@a": [`\${configDir}/from-head`] } } }),
    )
    await workspace.writeSource(
      "base/apps/web/tsconfig.json",
      JSON.stringify({ extends: "@repo/tsconfig/base.json" }),
    )
    await mkdir(at("head/node_modules/@repo"), { recursive: true })
    await linkDirectory(at("head/packages/tsconfig"), at("head/node_modules/@repo/tsconfig"))
    const logger = recordingLogger()
    const resolver = langTypescriptPlugin.createImportResolver({
      workspaceRoot: at("base"),
      installedRoot: at("head"),
      log: logger,
    })

    expect(await resolver.resolve("@a", "apps/web/src/page.ts")).toEqual(["apps/web/from-head"])
    expect(logger.warnings).toEqual([
      expect.stringMatching(
        /^node_modules\/@repo\/tsconfig\/base\.json could not be followed to where its links lead \(EPERM: .*\), so it is read where it is written\.$/,
      ),
    ])
  })
})

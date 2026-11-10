import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, git, initRepository, useScratchWorkspace } from "@aburi/test-support"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CliError } from "../src"
import { resolveWorkspaceRoot } from "../src/workspace-root"
import { writeMonorepo } from "./workspace"

const workspace = useScratchWorkspace("workspace-root")

describe("resolveWorkspaceRoot", () => {
  it("takes the directory itself when nothing around it is a workspace", async () => {
    const loose = resolve(workspace.root, "loose")
    await mkdir(loose)

    expect(await resolveWorkspaceRoot(loose)).toBe(loose)
  })

  it("finds the marker above the working directory", async () => {
    const app = await writeMonorepo(workspace.root)

    expect(await resolveWorkspaceRoot(app)).toBe(workspace.root)
  })

  it("refuses a workspace manifest it cannot parse instead of pretending there is none", async () => {
    await workspace.writeSource("pnpm-workspace.yaml", "packages:\n  - 'pkgs/*'\n")
    await workspace.writeSource("pkgs/app/package.json", '{ "name": "app", }')

    const error = await errorFrom(CliError, () =>
      resolveWorkspaceRoot(resolve(workspace.root, "pkgs/app")),
    )

    expect(error.code).toBe("config-error")
    expect(error.message).toContain("package.json")
  })
})

describe("resolveWorkspaceRoot with git told where the repository is", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each<[string, Record<string, string>, string | undefined, string]>([
    ["at home, which GIT_WORK_TREE names", {}, "..", "home"],
    [
      "at home, which core.worktree names",
      { "core.bare": "false", "core.worktree": "../home" },
      undefined,
      "home",
    ],
    [
      "at itself, which git takes as the top for want of a name",
      { "core.bare": "false" },
      undefined,
      "home/src",
    ],
    ["at the marker for a bare repository, which has no working tree", {}, undefined, "."],
  ])("roots home/src, below a marker, %s", async (_, config, workTreeVariable, root) => {
    await workspace.writeSource("pnpm-workspace.yaml", "packages: []\n")
    await mkdir(resolve(workspace.root, "home", "src"), { recursive: true })
    const gitDir = resolve(workspace.root, "dotfiles.git")
    await git(["init", "-q", "--bare", gitDir], workspace.root)
    for (const [key, value] of Object.entries(config)) {
      await git(["--git-dir", gitDir, "config", key, value], workspace.root)
    }
    vi.stubEnv("GIT_DIR", gitDir)
    vi.stubEnv("GIT_WORK_TREE", workTreeVariable)

    expect(await resolveWorkspaceRoot(resolve(workspace.root, "home", "src"))).toBe(
      resolve(workspace.root, root),
    )
  })

  it.each<[string, "GIT_DIR" | "GIT_WORK_TREE", (repository: string) => string, string]>([
    [
      "at the `.git` above it, under the GIT_DIR a hook exports",
      "GIT_DIR",
      (repository) => resolve(repository, ".git"),
      ".",
    ],
    [
      "at the GIT_WORK_TREE set beside the `.git` git finds",
      "GIT_WORK_TREE",
      () => "..",
      "packages",
    ],
  ])("roots a package of a repository %s", async (_, variable, value, root) => {
    const repository = resolve(workspace.root, "repo")
    await initRepository(repository)
    await mkdir(resolve(repository, "packages", "app"), { recursive: true })
    vi.stubEnv(variable, value(repository))

    expect(await resolveWorkspaceRoot(resolve(repository, "packages", "app"))).toBe(
      resolve(repository, root),
    )
  })
})

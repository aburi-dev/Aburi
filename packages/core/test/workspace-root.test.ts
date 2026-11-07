import { chmod, symlink } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { errorFrom, linkDirectory } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CoreError, detectWorkspaceRoot, type GitWorkTree } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-workspace-root")

async function rootFrom(...segments: string[]): Promise<string> {
  return detectWorkspaceRoot({ cwd: join(tree.root, ...segments) })
}

async function codeFrom(...segments: string[]): Promise<string> {
  return (await errorFrom(CoreError, () => rootFrom(...segments))).code
}

describe("a directory is a workspace root when it holds a marker", () => {
  it.each([
    ["pnpm-workspace.yaml", "packages: ['apps/*']"],
    ["turbo.json", "{}"],
    ["nx.json", "{}"],
    ["lerna.json", "{}"],
    ["go.work", "go 1.22\n"],
    [".aburi-workspace", ""],
    ["package.json", JSON.stringify({ name: "root", workspaces: ["apps/*"] })],
    ["Cargo.toml", '[workspace]\nmembers = ["crate-a"]\n'],
    ["Cargo.toml", '[workspace.members]\ncrate-a = "crate-a"\n'],
    ["pyproject.toml", '[tool.uv.workspace]\nmembers = ["pkg-a"]\n'],
    ["pyproject.toml", '[tool.hatch.workspaces]\nmembers = ["pkg-a"]\n'],
    ["pyproject.toml", '[tool.poetry]\nname = "root"\n'],
  ])("%s holding %j, with or without a byte order mark opening it", async (file, content) => {
    await tree.writeSource(file, content)
    expect(await rootFrom()).toBe(tree.root)

    await tree.writeSource(file, `\uFEFF${content}`)
    expect(await rootFrom()).toBe(tree.root)
  })

  it.each([
    ["package.json", JSON.stringify({ name: "plain-pkg" })],
    ["Cargo.toml", '[package]\nname = "crate-a"\n'],
    ["pyproject.toml", '[project]\nname = "pkg-a"\n'],
  ])("but not %s holding %j", async (file, content) => {
    await tree.writeSource(file, content)

    expect(await codeFrom()).toBe("workspace-root-not-found")
  })

  it("resolves a relative cwd against the process's working directory", async () => {
    await tree.writeSource("turbo.json", "{}")
    await tree.mkdir("src")

    const cwd = relative(process.cwd(), join(tree.root, "src"))

    expect(await detectWorkspaceRoot({ cwd })).toBe(tree.root)
  })
})

describe("the walk upward", () => {
  it("roots at an outer package.json#workspaces that opens with a byte order mark", async () => {
    await tree.writeSource("package.json", '\uFEFF{ "workspaces": ["apps/*"] }')
    await tree.writeSource("apps/billing/turbo.json", "{}")

    expect(await rootFrom("apps", "billing")).toBe(tree.root)
  })

  it("prefers the outermost marker over an inner package.json#workspaces", async () => {
    await tree.mkdir(".git")
    await tree.writePackage("apps/billing", { name: "billing", workspaces: ["lib/*"] })

    expect(await rootFrom("apps", "billing")).toBe(tree.root)
  })

  it("stops at a repository nested under another marker", async () => {
    await tree.mkdir(".git")
    await tree.mkdir("vendor/lib/.git")
    await tree.mkdir("vendor/lib/src")

    expect(await rootFrom("vendor", "lib", "src")).toBe(join(tree.root, "vendor", "lib"))
  })

  it("stops at the `.git` file a linked worktree or a submodule has", async () => {
    await tree.writeSource("pnpm-workspace.yaml", "packages: ['apps/*']")
    await tree.mkdir(".git")
    await tree.mkdir(".worktrees/feat/src")
    await tree.writeSource(".worktrees/feat/.git", "gitdir: ../../.git/worktrees/feat\n")

    expect(await rootFrom(".worktrees", "feat", "src")).toBe(join(tree.root, ".worktrees", "feat"))
  })

  it("stops at a `.git` beside another marker, in any probing order", async () => {
    await tree.writeSource("turbo.json", "{}")
    await tree.mkdir("repo/.git")
    await tree.mkdir("repo/src")
    await tree.writeSource("repo/turbo.json", "{}")

    expect(await rootFrom("repo", "src")).toBe(join(tree.root, "repo"))
  })

  it("passes a `.git` file that is not a `gitdir:` pointer", async () => {
    await tree.mkdir(".git")
    await tree.mkdir("vendor/lib/src")
    await tree.writeSource("vendor/lib/.git", "")

    expect(await rootFrom("vendor", "lib", "src")).toBe(tree.root)
  })
})

describe("a working tree git reports for a repository kept outside it", () => {
  const rootFor = (workTree: GitWorkTree, ...segments: string[]) =>
    detectWorkspaceRoot({ cwd: join(tree.root, ...segments), workTree })
  const named = (...segments: string[]): GitWorkTree => ({ top: join(tree.root, ...segments) })

  /** A work tree holding no marker of its own, below one the plain walk would climb to. */
  async function workTreeBelowMarker(): Promise<string> {
    await tree.writeSource("pnpm-workspace.yaml", "packages: []")
    await tree.mkdir("outer/wt/src")
    await tree.mkdir("outer/other")
    return join(tree.root, "outer", "wt")
  }

  it.each<[string, () => GitWorkTree, string[]]>([
    ["from the top", () => named("outer", "wt"), ["outer", "wt"]],
    ["from below it", () => named("outer", "wt"), ["outer", "wt", "src"]],
    ["named relative to the start", () => ({ top: ".." }), ["outer", "wt", "src"]],
  ])(
    "roots at the top git names, though a marker sits above it, %s",
    async (_, workTree, start) => {
      const top = await workTreeBelowMarker()

      expect(await rootFor(workTree(), ...start)).toBe(top)
    },
  )

  it.each<[string, string[], string, string]>([
    ["named as is, from below a link pointing shallower", ["outer", "wt"], "x/y/link", "q"],
    ["named through a link, from below a link pointing deeper", ["alias"], "link", "a/b/c"],
  ])(
    "meets the top as the ancestor that is the same directory, %s than it sits",
    async (_, top, link, target) => {
      const workTree = await workTreeBelowMarker()
      await linkDirectory(workTree, join(tree.root, "alias"))
      await tree.mkdir(join("outer", "wt", target, "sub"))
      await tree.mkdir(join("outer", "wt", dirname(link)))
      await linkDirectory(join(workTree, target), join(workTree, link))

      const start = join(workTree, link, "sub")
      expect(await detectWorkspaceRoot({ cwd: start, workTree: named(...top) })).toBe(workTree)
    },
  )

  it("still stops at a repository between the start and the top", async () => {
    const workTree = await workTreeBelowMarker()
    await tree.mkdir("outer/wt/vendor/lib/.git")
    await tree.mkdir("outer/wt/vendor/lib/src")

    expect(await rootFor(named("outer", "wt"), "outer", "wt", "vendor", "lib", "src")).toBe(
      join(workTree, "vendor", "lib"),
    )
  })

  it.each<[string, string, string[]]>([
    ["a sibling of the top", "wt", ["outer", "other"]],
    ["the top's parent", "wt", ["outer"]],
    ["below a top that is gone", "gone", ["outer", "wt", "src"]],
  ])("walks as if git had not answered from a start at %s", async (_, top, start) => {
    await workTreeBelowMarker()

    expect(await rootFor(named("outer", top), ...start)).toBe(tree.root)
  })

  it.skipIf(process.platform === "win32")(
    "raises a top it cannot resolve for any reason but its absence",
    async () => {
      await workTreeBelowMarker()
      await symlink("loop", join(tree.root, "outer", "loop"))

      await expect(rootFor(named("outer", "loop"), "outer", "wt", "src")).rejects.toThrow("ELOOP")
    },
  )

  it("roots at a start git takes as the top for want of a name, though a marker sits above it", async () => {
    await workTreeBelowMarker()

    expect(await rootFor("start", "outer", "wt", "src")).toBe(join(tree.root, "outer", "wt", "src"))
  })

  it("roots at the `.git` above a start git takes as the top, as a hook run from a package does", async () => {
    await tree.mkdir(".git")
    await tree.mkdir("packages/app")

    expect(await rootFor("start", "packages", "app")).toBe(tree.root)
  })
})

describe("a manifest that cannot be read", () => {
  it("is raised below the workspace root", async () => {
    await tree.mkdir(".git")
    await tree.writeSource("apps/billing/package.json", "{ not json")

    expect(await codeFrom("apps", "billing")).toBe("workspace-manifest-malformed")
  })

  it.each([
    ["that is not JSON", "{ not json"],
    ["with a byte order mark after its first character", '{\uFEFF "workspaces": [] }'],
  ])("is raised at the workspace root itself, for a manifest %s", async (_case, content) => {
    await tree.writeSource("package.json", content)
    await tree.writeSource("Cargo.toml", '[workspace]\nmembers = ["crate-a"]\n')

    expect(await codeFrom()).toBe("workspace-manifest-malformed")
  })

  it("is never opened in a directory a `.git` already makes the root", async () => {
    await tree.mkdir(".git")
    await tree.writeSource("package.json", "{ not json")

    expect(await rootFrom()).toBe(tree.root)
  })

  it("is ignored above the workspace root", async () => {
    await tree.writeSource("home/repo/pnpm-workspace.yaml", "packages: ['apps/*']")
    await tree.writeSource("home/package.json", "{ not json")

    expect(await rootFrom("home", "repo")).toBe(join(tree.root, "home", "repo"))
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "is ignored above the workspace root when the filesystem refuses it",
    async () => {
      await tree.writeSource("home/repo/pnpm-workspace.yaml", "packages: ['apps/*']")
      const denied = join(tree.root, "home", "package.json")
      await tree.writeSource("home/package.json", JSON.stringify({ name: "someone-else" }))
      await chmod(denied, 0o000)
      try {
        expect(await rootFrom("home", "repo")).toBe(join(tree.root, "home", "repo"))
      } finally {
        await chmod(denied, 0o600)
      }
    },
  )

  it("leaves an absent root reported as workspace-root-not-found", async () => {
    await tree.mkdir("home/plain")
    await tree.writeSource("home/package.json", "{ not json")

    expect(await codeFrom("home", "plain")).toBe("workspace-root-not-found")
  })
})

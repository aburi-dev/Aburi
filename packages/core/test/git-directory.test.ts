import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  commitAll,
  git,
  initRepository,
  makeGitDirectory,
  makeGitPointer,
  useScratchWorkspace,
} from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { isRepository } from "../src/git-directory"

const scratch = useScratchWorkspace("core-git-directory")

const at = (...segments: string[]): string => join(scratch.root, ...segments)

describe("a .git git itself made", () => {
  it("is a repository in a fresh checkout", async () => {
    await initRepository(at("repo"))

    expect(await isRepository(at("repo", ".git"))).toBe(true)
  })

  it("is a repository in a linked worktree, whose git directory shares objects through commondir", async () => {
    await initRepository(at("repo"))
    await writeFile(at("repo", "a.txt"), "a\n", "utf8")
    await commitAll(at("repo"))
    await git(["worktree", "add", "-q", at("linked")], at("repo"))

    expect(await isRepository(at("linked", ".git"))).toBe(true)
  })
})

describe("a .git directory", () => {
  it.each([
    ["a branch", "ref: refs/heads/main\n"],
    ["a branch, with no space after ref:", "ref:refs/heads/main"],
    ["a detached SHA-1 commit", `${"a".repeat(40)}\n`],
    ["a detached SHA-256 commit", `${"b".repeat(64)}\n`],
  ])("is a repository when HEAD names %s", async (_, head) => {
    await makeGitDirectory(at(".git"))
    await writeFile(at(".git", "HEAD"), head, "utf8")

    expect(await isRepository(at(".git"))).toBe(true)
  })

  it.each([
    ["is empty", ""],
    ["names no ref", "ref: heads/main\n"],
    ["names a short object id", `${"a".repeat(12)}\n`],
    ["is not git's", "hello\n"],
  ])("is no repository when HEAD %s", async (_, head) => {
    await makeGitDirectory(at(".git"))
    await writeFile(at(".git", "HEAD"), head, "utf8")

    expect(await isRepository(at(".git"))).toBe(false)
  })

  it.each(["HEAD", "objects", "refs"])("is no repository without %s", async (entry) => {
    await makeGitDirectory(at(".git"))
    await rm(at(".git", entry), { recursive: true })

    expect(await isRepository(at(".git"))).toBe(false)
  })

  it("is no repository when it is empty", async () => {
    await mkdir(at(".git"))

    expect(await isRepository(at(".git"))).toBe(false)
  })

  it.skipIf(process.platform === "win32")("reads a HEAD symlink by where it points", async () => {
    await makeGitDirectory(at("ref", ".git"))
    await rm(at("ref", ".git", "HEAD"))
    await symlink("refs/heads/main", at("ref", ".git", "HEAD"))
    await makeGitDirectory(at("elsewhere", ".git"))
    await rm(at("elsewhere", ".git", "HEAD"))
    await symlink("../outside", at("elsewhere", ".git", "HEAD"))

    expect(await isRepository(at("ref", ".git"))).toBe(true)
    expect(await isRepository(at("elsewhere", ".git"))).toBe(false)
  })

  it("takes objects and refs from the directory commondir names, and from nowhere else", async () => {
    await makeGitDirectory(at("common"))
    await mkdir(at("worktree-git"))
    await writeFile(at("worktree-git", "HEAD"), "ref: refs/heads/side\n", "utf8")
    await writeFile(at("worktree-git", "commondir"), "../common\n", "utf8")
    await makeGitDirectory(at("orphan-git"))
    await writeFile(at("orphan-git", "commondir"), "../nowhere\n", "utf8")

    expect(await isRepository(at("worktree-git"))).toBe(true)
    expect(await isRepository(at("orphan-git"))).toBe(false)
  })
})

describe("a .git file", () => {
  it.each([
    ["an absolute", (root: string) => join(root, "store", "wt")],
    ["a relative", () => "../store/wt"],
  ])("is a repository when it points at %s git directory", async (_, target) => {
    await makeGitPointer(at("checkout", ".git"), target(scratch.root))

    expect(await isRepository(at("checkout", ".git"))).toBe(true)
  })

  it("reads a pointer written with a CRLF ending", async () => {
    await makeGitDirectory(at("store"))
    await writeFile(at(".git"), `gitdir: ${at("store")}\r\n`, "utf8")

    expect(await isRepository(at(".git"))).toBe(true)
  })

  it.each([
    ["is empty", () => ""],
    ["names no directory", () => "gitdir: \n"],
    ["is no pointer", (root: string) => `${join(root, "store")}\n`],
    ["points at nothing", (root: string) => `gitdir: ${join(root, "absent")}\n`],
    ["points at a directory that is no git directory", (root: string) => `gitdir: ${root}\n`],
  ])("is no repository when it %s", async (_, content) => {
    await makeGitDirectory(at("store"))
    await writeFile(at(".git"), content(scratch.root), "utf8")

    expect(await isRepository(at(".git"))).toBe(false)
  })
})

it("is no repository where nothing is", async () => {
  expect(await isRepository(at(".git"))).toBe(false)
})

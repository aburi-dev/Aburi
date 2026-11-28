import type { Stats } from "node:fs"
import { lstat, open, readFile, readlink, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { isVanishedFile } from "./scan/faults"

const GITDIR_POINTER = "gitdir: "

// A pointer file is one line; git reads no further into one than this either.
const POINTER_READ_LIMIT = 4096

/**
 * Whether a `.git` at `path` makes its directory a checkout as git reads one: a directory that is
 * a git directory, or a file opening with `gitdir: ` that names one.
 */
export async function isRepository(path: string): Promise<boolean> {
  const entry = await statOrNull(path)
  if (entry === null) return false
  if (entry.isDirectory()) return isGitDirectory(path)
  if (!entry.isFile()) return false
  const target = await pointerTarget(path)
  return target !== null && (await isGitDirectory(target))
}

async function pointerTarget(path: string): Promise<string | null> {
  const handle = await open(path, "r")
  let text: string
  try {
    const buffer = Buffer.alloc(POINTER_READ_LIMIT)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    text = buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
  if (!text.startsWith(GITDIR_POINTER)) return null
  const named = text.slice(GITDIR_POINTER.length).replace(/[\r\n]+$/, "")
  if (named.length === 0) return null
  return isAbsolute(named) ? named : resolve(dirname(path), named)
}

// Git's own test: a `HEAD` naming a ref or a commit, and `objects/` and `refs/` in the directory
// the git directory shares them from, which a linked worktree's `commondir` names.
async function isGitDirectory(dir: string): Promise<boolean> {
  if (!(await hasValidHead(dir))) return false
  const common = await commonDirectoryOf(dir)
  return (await isDirectory(join(common, "objects"))) && (await isDirectory(join(common, "refs")))
}

async function hasValidHead(dir: string): Promise<boolean> {
  const head = join(dir, "HEAD")
  const link = await lstatOrNull(head)
  if (link === null) return false
  if (link.isSymbolicLink()) return (await readlink(head)).startsWith("refs/")
  if (!link.isFile()) return false
  const text = (await readText(head)) ?? ""
  if (text.startsWith("ref:")) return text.slice("ref:".length).trimStart().startsWith("refs/")
  return DETACHED_HEAD.test(text)
}

// Git reads a detached HEAD by the object id it opens with, and the shortest id it hashes is 40 digits.
const DETACHED_HEAD = /^[0-9a-f]{40}/i

async function commonDirectoryOf(dir: string): Promise<string> {
  const named = (await readText(join(dir, "commondir")))?.trimEnd()
  if (named === undefined || named.length === 0) return dir
  return isAbsolute(named) ? named : resolve(dir, named)
}

async function isDirectory(path: string): Promise<boolean> {
  return (await statOrNull(path))?.isDirectory() === true
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch (error: unknown) {
    if (isVanishedFile(error)) return null
    throw error
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if (isVanishedFile(error)) return null
    throw error
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error: unknown) {
    if (isVanishedFile(error)) return undefined
    throw error
  }
}

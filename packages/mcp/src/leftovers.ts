import { execFile } from "node:child_process"
import { realpathSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Removes `temporary`, the directory a run was given as its system temp dir, with whatever the run
 * left there: the base worktree of an `aburi diff` killed before its own cleanup, unregistered
 * from the repository at `cwd` first. Answers with what could not be removed.
 */
export async function removeLeftovers(
  temporary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const problems: string[] = []
  const left = await readdir(temporary).catch(() => [])
  if (left.length > 0) {
    for (const worktree of await worktreesUnder(temporary, cwd, env)) {
      await run("git", ["worktree", "remove", "--force", worktree], { cwd, env }).catch(
        (error: unknown) =>
          problems.push(`could not remove the git worktree ${worktree}: ${messageOf(error)}`),
      )
    }
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    (error: unknown) => problems.push(`could not remove ${temporary}: ${messageOf(error)}`),
  )
  return problems
}

async function worktreesUnder(
  directory: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  let listed: string
  try {
    listed = (await run("git", ["worktree", "list", "--porcelain"], { cwd, env })).stdout
  } catch {
    // Not a repository, so no worktree to unregister.
    return []
  }
  // Git may record the path as given or resolved, and macOS links its temp dir elsewhere.
  const roots = [directory, realpathSync.native(directory)]
  return listed
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => roots.some((root) => isWithin(root, resolve(path))))
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error)
}

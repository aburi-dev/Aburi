import { resolve } from "node:path"
import { CoreError, detectWorkspaceRoot, type GitWorkTree } from "@aburi/core"
import { CliError } from "./errors"
import { defaultGitRunner } from "./git/runner"

export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  const workTree = await askGitForWorkTree(cwd)
  try {
    return await detectWorkspaceRoot({ cwd, ...(workTree === null ? {} : { workTree }) })
  } catch (error) {
    if (error instanceof CoreError && error.code === "workspace-root-not-found") {
      return resolve(cwd)
    }
    const subject =
      error instanceof CoreError && error.value !== undefined ? ` (${error.value})` : ""
    const detail = error instanceof Error ? error.message : String(error)
    throw new CliError(
      `Could not determine the workspace root for ${resolve(cwd)}${subject}: ${detail}`,
      error instanceof CoreError ? "config-error" : "runtime-error",
    )
  }
}

/**
 * Asked only while `GIT_DIR` or `GIT_WORK_TREE` is set: without them a `.git` marks the top, and a
 * scan spawns no git.
 */
async function askGitForWorkTree(cwd: string): Promise<GitWorkTree | null> {
  const named = isSet(process.env.GIT_WORK_TREE)
  if (!named && !isSet(process.env.GIT_DIR)) return null
  // git refuses a bare repository, which has no working tree, as it refuses outside any repository.
  const top = await gitAnswer(cwd, ["rev-parse", "--show-toplevel"])
  if (top === null) return null
  if (named || (await gitAnswer(cwd, ["config", "--get", "core.worktree"])) !== null) {
    return { top }
  }
  return "start"
}

/** `null` for a refusal, or for a git that cannot be run: either leaves the walk as it would be. */
async function gitAnswer(cwd: string, args: readonly string[]): Promise<string | null> {
  let stdout: string
  try {
    stdout = (await defaultGitRunner.run(args, { cwd })).stdout
  } catch {
    return null
  }
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.length > 0
}

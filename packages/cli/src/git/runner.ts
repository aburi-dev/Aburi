import { spawn } from "node:child_process"

export interface GitRunOptions {
  cwd?: string
  /**
   * Variables set for this command alone, on top of the environment every command gets. A runner
   * has to apply them: one names a scratch index, and without it the command writes the caller's.
   */
  env?: Readonly<Record<string, string>>
}

export interface GitRunner {
  run(args: readonly string[], options?: GitRunOptions): Promise<{ stdout: string; stderr: string }>
}

const UNINHERITED_GIT_ENV: readonly string[] = ["GIT_INDEX_FILE", "GIT_PREFIX"]

export function gitChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...env }
  for (const name of UNINHERITED_GIT_ENV) delete child[name]
  return child
}

export const defaultGitRunner: GitRunner = {
  async run(
    args: readonly string[],
    options?: GitRunOptions,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const env = { ...gitChildEnv(), ...options?.env }
      const child = spawn("git", args, { cwd: options?.cwd, env })
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk)
      })
      child.on("error", rejectPromise)
      child.on("close", (code, signal) => {
        // Decoded once: a multi-byte character split across two chunks would become U+FFFD.
        const stdout = Buffer.concat(stdoutChunks).toString("utf8")
        const stderr = Buffer.concat(stderrChunks).toString("utf8")
        if (code === 0) return resolvePromise({ stdout, stderr })
        const how =
          code === null ? `was killed by ${signal ?? "a signal"}` : `exited with code ${code}`
        rejectPromise(new Error(`git ${args.join(" ")} ${how}: ${stderr}`))
      })
    })
  },
}

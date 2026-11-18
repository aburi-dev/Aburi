import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { containsPath } from "./args.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, "../..")

export function cliEntry(root = REPO_ROOT) {
  return resolve(root, "packages/cli/dist/index.mjs")
}

export function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    })
    let stdout = ""
    let stderr = ""
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL")
          stderr += `\n[harness] killed after ${options.timeoutMs} ms\n`
        }, options.timeoutMs)
      : null
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr })
    })
  })
}

export async function git(args, cwd) {
  const result = await run("git", args, { cwd })
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`)
  return result.stdout.trim()
}

export async function aburiVersion() {
  return JSON.parse(await readFile(resolve(REPO_ROOT, "packages/cli/package.json"), "utf8")).version
}

export async function aburiCommit(root = REPO_ROOT) {
  const commit = await git(["rev-parse", "HEAD"], root)
  const status = await git(
    ["status", "--porcelain", "--", ".", ":(exclude)benchmarks/public-repos/results"],
    root,
  )
  return { commit, dirty: status !== "" }
}

export function pluginRef(ref, root = REPO_ROOT) {
  const name = ref.replace(/^@aburi\//, "")
  return pathToFileURL(resolve(root, "packages", name, "dist/index.mjs")).href
}

export function assertRunnable(workDir, baseline = null) {
  const unbuilt = [REPO_ROOT, ...(baseline === null ? [] : [baseline])].filter(
    (root) => !existsSync(cliEntry(root)),
  )
  if (unbuilt.length > 0) {
    throw new Error(
      unbuilt
        .map((root) => `${cliEntry(root)} is missing. Run \`pnpm build\` in ${root} first.`)
        .join(" "),
    )
  }
  if (containsPath(REPO_ROOT, workDir)) {
    throw new Error(
      `--work-dir must sit outside ${REPO_ROOT}; a clone below it is absorbed into this ` +
        "workspace and the scan measures the wrong tree.",
    )
  }
}

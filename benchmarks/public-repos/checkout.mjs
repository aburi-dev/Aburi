import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { containsPath } from "./args.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, "../..")
export const CLI_ENTRY = resolve(REPO_ROOT, "packages/cli/dist/index.mjs")

const execFileAsync = promisify(execFile)

export async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed:\n${error.stderr ?? error.message}`)
  }
}

export async function aburiVersion() {
  return JSON.parse(await readFile(resolve(REPO_ROOT, "packages/cli/package.json"), "utf8")).version
}

export async function aburiCommit() {
  const commit = await git(["rev-parse", "HEAD"], REPO_ROOT)
  const status = await git(
    ["status", "--porcelain", "--", ".", ":(exclude)benchmarks/public-repos/results"],
    REPO_ROOT,
  )
  return { commit, dirty: status !== "" }
}

export function pluginRef(ref) {
  const name = ref.replace(/^@aburi\//, "")
  return pathToFileURL(resolve(REPO_ROOT, "packages", name, "dist/index.mjs")).href
}

export function assertRunnable(workDir) {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`${relative(REPO_ROOT, CLI_ENTRY)} is missing. Run \`pnpm build\` first.`)
  }
  if (containsPath(REPO_ROOT, workDir)) {
    throw new Error(
      `--work-dir must sit outside ${REPO_ROOT}; a clone below it is absorbed into this ` +
        "workspace and the scan measures the wrong tree.",
    )
  }
}

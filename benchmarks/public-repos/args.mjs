import { tmpdir } from "node:os"
import { posix, resolve, win32 } from "node:path"

export const DEFAULT_WORK_DIR = resolve(tmpdir(), "aburi-bench-work")

export function containsPath(root, candidate, platform = process.platform) {
  const api = platform === "win32" ? win32 : posix
  const rel = api.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel))
}

export function requireValue(argv, index, flag) {
  const value = argv[index]
  if (value === undefined) throw new Error(`${flag} needs a value.`)
  return value
}

export function requireCount(argv, index, flag, minimum) {
  const raw = requireValue(argv, index, flag)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${flag} needs a whole number of at least ${minimum}, not "${raw}".`)
  }
  return value
}

export function resolveRepos(manifest, only) {
  if (only === null) return manifest.repos
  const known = manifest.repos.map((repo) => repo.id)
  const unknown = only.filter((id) => !known.includes(id))
  if (unknown.length > 0) {
    throw new Error(
      `--only names ${unknown.map((id) => `"${id}"`).join(", ")}, which repos.json does not ` +
        `carry. Known ids: ${known.join(", ")}.`,
    )
  }
  return manifest.repos.filter((repo) => only.includes(repo.id))
}

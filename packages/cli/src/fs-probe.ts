import { access, stat } from "node:fs/promises"
import { CliError, errorCode, errorMessage } from "./errors"

export const ABSENT_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"])

async function probe<T>(path: string, read: () => Promise<T>, absent: T): Promise<T> {
  try {
    return await read()
  } catch (error) {
    const code = errorCode(error)
    if (code !== null && ABSENT_ERRNOS.has(code)) return absent
    throw new CliError(`Failed to probe ${path}: ${errorMessage(error)}`, "runtime-error", {
      cause: error,
    })
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return probe(
    path,
    async () => {
      await access(path)
      return true
    },
    false,
  )
}

/** Whether `a` and `b` are one directory entry, however each is spelled, cased or reached through a link. */
export async function samePlace(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  const [first, second] = await Promise.all([identity(a), identity(b)])
  return first !== null && first === second
}

/** Null where there is nothing, or where the filesystem numbers no file (FAT and some shares give 0). */
async function identity(path: string): Promise<string | null> {
  return probe(
    path,
    async () => {
      const { dev, ino } = await stat(path, { bigint: true })
      return ino === 0n ? null : `${dev}:${ino}`
    },
    null,
  )
}

export async function pathKind(path: string): Promise<"nothing" | "file" | "directory"> {
  return probe(
    path,
    async () => ((await stat(path)).isDirectory() ? "directory" : "file"),
    "nothing",
  )
}

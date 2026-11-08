import type { GitRunner } from "./runner"

/**
 * `-z` keeps each path whole: without it, git quotes a path outside printable ASCII the way
 * `core.quotePath` asks.
 */
export async function listIndex(git: GitRunner, checkoutRoot: string): Promise<string> {
  const { stdout } = await git.run(["ls-files", "-z", "--stage"], { cwd: checkoutRoot })
  return stdout
}

export function pathsWithMode(listing: string, mode: "120000" | "160000"): string[] {
  const prefix = `${mode} `
  // A Set, since an unmerged path has a record for each of its stages.
  const paths = new Set<string>()
  for (const record of listing.split("\0")) {
    if (!record.startsWith(prefix)) continue
    const tab = record.indexOf("\t")
    if (tab !== -1) paths.add(record.slice(tab + 1))
  }
  return [...paths].sort()
}

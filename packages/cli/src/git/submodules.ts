import type { WarnFn } from "../warn"
import { pathsWithMode } from "./index-listing"

export function submoduleIgnorePatterns(indexListing: string, warn: WarnFn): string[] {
  const paths = pathsWithMode(indexListing, "160000")
  if (paths.length === 0) return []
  warn(
    `⚠ Submodules detected: ${paths.join(", ")}. Submodule-aware diff is not yet supported, so their files are left out of both file scans. Component detection still walks them, so a workspace package inside one can still be reported as a Component added or removed.`,
  )
  return paths.map((path) => `${escapeGlob(path)}/**`)
}

function escapeGlob(path: string): string {
  return path.replace(/[\\()[\]{}*?|!+@]/g, "\\$&")
}

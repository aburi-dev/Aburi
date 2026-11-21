import { type PackageEntryFields, packageName, type WorkspacePackage } from "../component-manifest"

/**
 * The workspace paths an import of a workspace package by its name can load, each to probe as a
 * relative specifier's, so `./index.js` finds `index.ts`. The scan cannot know which condition a
 * consumer resolves, so it tries every target in the order the manifest writes them.
 */
export function packageEntryPaths(pkg: WorkspacePackage, specifier: string): string[] {
  if (packageName(specifier) !== pkg.name) return []
  const subpath = `.${specifier.slice(pkg.name.length)}`
  const entry = pkg.entry ?? {}
  const leaves =
    entry.exports == null ? legacyEntries(entry, subpath) : exportedEntries(entry.exports, subpath)
  const paths: string[] = []
  for (const leaf of leaves) {
    const path = packagePath(pkg.root, leaf)
    if (path !== null && !paths.includes(path)) paths.push(path)
  }
  return paths
}

function legacyEntries(entry: PackageEntryFields, subpath: string): string[] {
  if (subpath !== ".") return [subpath]
  const fields = [entry.main, entry.module, entry.types, entry.typings]
  return [...fields.filter((field): field is string => typeof field === "string"), "."]
}

function exportedEntries(exports: unknown, subpath: string): string[] {
  if (!isSubpathMap(exports)) return subpath === "." ? targetsOf(exports, null) : []
  const exact = exports[subpath]
  if (exact !== undefined) return targetsOf(exact, null)
  let best: { key: string; match: string } | null = null
  for (const key of Object.keys(exports)) {
    const star = key.indexOf("*")
    if (star === -1 || key.indexOf("*", star + 1) !== -1) continue
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)]
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    if (subpath.length < key.length) continue
    // Node takes the pattern with the longest prefix, then the longest key.
    if (best !== null && comparePatterns(best.key, key) <= 0) continue
    best = { key, match: subpath.slice(prefix.length, subpath.length - suffix.length) }
  }
  return best === null ? [] : targetsOf(exports[best.key], best.match)
}

function isSubpathMap(exports: unknown): exports is Readonly<Record<string, unknown>> {
  if (typeof exports !== "object" || exports === null || Array.isArray(exports)) return false
  return Object.keys(exports).some((key) => key.startsWith("."))
}

function comparePatterns(a: string, b: string): number {
  const prefixA = a.indexOf("*")
  const prefixB = b.indexOf("*")
  if (prefixA !== prefixB) return prefixB - prefixA
  return b.length - a.length
}

function targetsOf(target: unknown, match: string | null): string[] {
  if (typeof target === "string") {
    if (!target.startsWith("./")) return []
    return [match === null ? target : target.replaceAll("*", match)]
  }
  if (Array.isArray(target)) return target.flatMap((entry) => targetsOf(entry, match))
  if (typeof target === "object" && target !== null) {
    return Object.values(target).flatMap((entry) => targetsOf(entry, match))
  }
  return []
}

function packagePath(root: string, leaf: string): string | null {
  const segments = leaf.split("/").filter((segment) => segment.length > 0 && segment !== ".")
  if (segments.includes("..")) return null
  const path = segments.join("/")
  if (root === "." || root === "") return path.length === 0 ? "." : path
  return path.length === 0 ? root : `${root}/${path}`
}

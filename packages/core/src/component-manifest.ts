import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { toNfc } from "./codepoints"
import { isRecord } from "./collections"
import { CoreError } from "./errors"
import { unnameableSite } from "./id"
import { compareCodeUnit } from "./order"
import { describeThrown, isVanishedFile } from "./scan/faults"
import { parseManifestJson } from "./workspace-fs"

const NPM_DEP_TO_FRAMEWORK: ReadonlyArray<readonly [string, string]> = [
  ["@nestjs/core", "nestjs"],
  ["next", "nextjs"],
  ["react", "react"],
  ["vue", "vue"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["koa", "koa"],
  ["hono", "hono"],
  ["astro", "astro"],
  ["svelte", "svelte"],
  ["@sveltejs/kit", "svelte"],
  ["solid-js", "solid"],
  ["@trpc/server", "trpc"],
]

/** Every framework id a detected Component can record. */
export const DETECTED_FRAMEWORKS: ReadonlySet<string> = new Set(
  NPM_DEP_TO_FRAMEWORK.map(([, framework]) => framework),
)

export const NPM_MANIFEST = "package.json"

const MANIFEST_PRIORITY: readonly string[] = [
  NPM_MANIFEST,
  "project.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
]

function orderedManifests(manifests: ReadonlyMap<string, string>): [string, string][] {
  const ranked = [...manifests].filter(([kind]) => MANIFEST_PRIORITY.includes(kind))
  ranked.sort(([a], [b]) => MANIFEST_PRIORITY.indexOf(a) - MANIFEST_PRIORITY.indexOf(b))
  const unranked = [...manifests].filter(([kind]) => !MANIFEST_PRIORITY.includes(kind))
  unranked.sort(([a], [b]) => compareCodeUnit(a, b))
  return [...ranked, ...unranked]
}

export interface ReadManifest {
  kind: string
  manifest: ManifestIdentity | null
}

export async function readCandidateManifests(entry: {
  readonly absoluteRoot: string
  readonly manifests: ReadonlyMap<string, string>
}): Promise<ReadManifest[]> {
  const paths = new Map(entry.manifests)
  if (!paths.has(NPM_MANIFEST)) {
    paths.set(NPM_MANIFEST, join(entry.absoluteRoot, NPM_MANIFEST))
  }
  return Promise.all(
    orderedManifests(paths).map(async ([kind, path]) => ({
      kind,
      manifest: await readJsonManifest(path),
    })),
  )
}

/** A `package.json#name` and the workspace-relative root whose manifest declares it. */
export interface WorkspacePackage {
  name: string
  root: string
  /** Absent when the manifest names no entry point. */
  entry?: PackageEntryFields
}

/** The fields of a package's `package.json` that say which file an import of it by name loads. */
export interface PackageEntryFields {
  exports?: unknown
  main?: unknown
  module?: unknown
  types?: unknown
  typings?: unknown
}

const ENTRY_FIELDS = ["exports", "main", "module", "types", "typings"] as const

/**
 * The package a bare specifier imports: `@scope/name` for a scoped one, otherwise its first segment.
 * `null` for one no package can be named by: a subpath import (`#x`), private to the importing
 * package, and a bundler's alias spelled with an empty scope (`@/x`) or a `~`.
 */
export function packageName(specifier: string): string | null {
  const [first, second] = specifier.split("/")
  if (first === undefined || first.length === 0) return null
  if (first.startsWith("#") || first === "@" || first.startsWith("~")) return null
  if (!first.startsWith("@")) return first
  if (second === undefined || second.length === 0) return null
  return `${first}/${second}`
}

export async function readWorkspacePackages(
  workspaceRoot: string,
  roots: readonly string[],
): Promise<WorkspacePackage[]> {
  const unique = [...new Set(roots)].sort(compareCodeUnit)
  // Which read fails first is timing, so the failure reported is the first root's.
  const settled = await Promise.allSettled(
    unique.map(async (root) => ({
      root,
      manifest: await readJsonManifest(join(workspaceRoot, root, NPM_MANIFEST)),
    })),
  )
  return settled.flatMap((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason
    const { root, manifest } = outcome.value
    const name: unknown = manifest?.name
    if (typeof name !== "string" || name.length === 0) return []
    const entry = entryFieldsOf(manifest ?? {})
    return [entry === null ? { name, root } : { name, root, entry }]
  })
}

function entryFieldsOf(manifest: PackageEntryFields): PackageEntryFields | null {
  const entry: PackageEntryFields = {}
  for (const field of ENTRY_FIELDS) {
    if (manifest[field] !== undefined) entry[field] = manifest[field]
  }
  return Object.keys(entry).length === 0 ? null : entry
}

export interface ManifestIdentity {
  name?: string
}

export interface NpmManifest extends ManifestIdentity {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  exports?: unknown
  main?: string
  module?: string
  types?: string
  typings?: string
}

async function readJsonManifest(path: string): Promise<Readonly<Record<string, unknown>> | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (cause) {
    if (isVanishedFile(cause)) return null
    throw new CoreError(
      `Manifest at ${path} could not be read: ${describeThrown(cause)}`,
      { code: "workspace-manifest-malformed", value: path },
      { cause },
    )
  }
  const parsed = parseManifestJson(raw, path)
  return isRecord(parsed) ? parsed : null
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

/** Every package a manifest names in one of its dependency fields. */
export function dependencyNamesOf(manifest: NpmManifest | null): Set<string> {
  const names = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    const block: unknown = manifest?.[field]
    if (isRecord(block)) for (const name of Object.keys(block)) names.add(name)
  }
  return names
}

export function collectFrameworks(manifest: NpmManifest | null): string[] {
  const depKeys = dependencyNamesOf(manifest)
  const out = new Set<string>()
  for (const [dep, framework] of NPM_DEP_TO_FRAMEWORK) {
    if (depKeys.has(dep)) out.add(framework)
  }
  return [...out].sort(compareCodeUnit)
}

export type IgnoredPublicApiReason =
  | "package-directory"
  | "directory"
  | "absolute-path"
  | "parent-segment"
  | "drive-shaped-name"
  | "unspellable-name"

/** A string `package.json` value that gives no `publicApi` entry. */
export interface IgnoredPublicApiValue {
  /** `main`, `module`, `types`, `typings`, or the place in `exports`: `exports["./lib/"]`. */
  field: string
  value: string
  reason: IgnoredPublicApiReason
}

export interface PublicApi {
  /** Workspace-relative, sorted. */
  entries: string[]
  ignored: IgnoredPublicApiValue[]
}

const TOP_LEVEL_PATH_FIELDS: ReadonlySet<string> = new Set(["main", "module", "types", "typings"])

export function collectPublicApi(manifest: NpmManifest | null, root: string): PublicApi {
  const found = new Set<string>()
  const ignored: IgnoredPublicApiValue[] = []
  const take = (field: string, raw: unknown): void => {
    if (typeof raw !== "string") return
    const outcome = normalizePackagePath(raw)
    if (typeof outcome === "string") found.add(root === "." ? outcome : `${root}/${outcome}`)
    else ignored.push({ field, value: raw, reason: outcome.reason })
  }
  // The manifest's own key order, so what is ignored is said in the order the file reads.
  for (const [field, raw] of Object.entries(manifest ?? {})) {
    if (field === "exports") collectFromExports(raw, field, take)
    else if (TOP_LEVEL_PATH_FIELDS.has(field)) take(field, raw)
  }
  return { entries: [...found].sort(compareCodeUnit), ignored }
}

function collectFromExports(
  value: unknown,
  field: string,
  take: (field: string, raw: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectFromExports(entry, `${field}[${index}]`, take)
    }
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      collectFromExports(entry, `${field}[${JSON.stringify(key)}]`, take)
    }
    return
  }
  take(field, value)
}

function normalizePackagePath(raw: string): string | { reason: IgnoredPublicApiReason } {
  if (raw.startsWith("/")) return { reason: "absolute-path" }
  const segments = toNfc(raw).split("/")
  const kept = segments.filter((segment) => segment.length > 0 && segment !== ".")
  if (kept.length === 0) return { reason: "package-directory" }
  const last = segments[segments.length - 1]
  if (last === "" || last === ".") return { reason: "directory" }
  const path = kept.join("/")
  const site = unnameableSite(path)
  if (site !== null) return { reason: site.reason }
  // An entry is the value's own spelling, so `./src/../index.js` is refused though it stays inside.
  if (kept.includes("..")) return { reason: "parent-segment" }
  return path
}

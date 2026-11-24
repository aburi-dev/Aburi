import { hasMatchingImport } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"

// A package whose every module, `@prisma/client/edge` and `/runtime/…` included, is the client's.
const PRISMA_CLIENT_MODULES_LIST = ["@prisma/client"] as const

type PrismaClientModule = (typeof PRISMA_CLIENT_MODULES_LIST)[number]

const PRISMA_CLIENT_MODULES: ReadonlySet<PrismaClientModule> = new Set(PRISMA_CLIENT_MODULES_LIST)

// A driver adapter or a client extension is imported where the client is built.
const PRISMA_CLIENT_COMPANION_PREFIXES = ["@prisma/adapter-", "@prisma/extension-"] as const

const GENERATED_CLIENT_DIRECTORY = ["generated", "prisma"] as const

const GENERATED_CLIENT_ENTRIES: ReadonlySet<string> = new Set(["client", "edge", "browser"])

const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/

export type PrismaClientModuleMatcher = (source: string) => boolean

/**
 * The modules a Prisma client is imported from: `@prisma/client` and its subpaths, a driver
 * adapter or client extension, a client generated to `generated/prisma` (Prisma 6.6's `prisma
 * init` default and Prisma 7's), and the modules `clientModules` names.
 */
export function prismaClientModuleMatcher(
  clientModules: readonly string[] = [],
): PrismaClientModuleMatcher {
  const configured = clientModules.map(moduleSegments)
  const answers = new Map<string, boolean>()
  return (source) => {
    let answer = answers.get(source)
    if (answer === undefined) {
      answer = isPrismaClientModule(source, configured)
      answers.set(source, answer)
    }
    return answer
  }
}

function isPrismaClientModule(source: string, configured: readonly (readonly string[])[]): boolean {
  const packageName = source.split("/", 2).join("/")
  if ((PRISMA_CLIENT_MODULES as ReadonlySet<string>).has(packageName)) return true
  if (
    PRISMA_CLIENT_COMPANION_PREFIXES.some(
      (prefix) => source.startsWith(prefix) && source.length > prefix.length,
    )
  ) {
    return true
  }
  const segments = moduleSegments(source)
  return isGeneratedClient(segments) || configured.some((entry) => endsWith(segments, entry))
}

/** A module's segments as an import spells them, an extension and an `index` file left off. */
export function moduleSegments(specifier: string): readonly string[] {
  const segments = specifier.replace(SCRIPT_EXTENSION, "").split("/")
  if (segments.at(-1) === "index") segments.pop()
  return segments.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function isGeneratedClient(segments: readonly string[]): boolean {
  const last = segments.at(-1)
  const directory =
    last !== undefined && GENERATED_CLIENT_ENTRIES.has(last) ? segments.slice(0, -1) : segments
  return endsWith(directory, GENERATED_CLIENT_DIRECTORY)
}

function endsWith(segments: readonly string[], tail: readonly string[]): boolean {
  if (tail.length === 0 || tail.length > segments.length) return false
  const offset = segments.length - tail.length
  return tail.every((segment, index) => segments[offset + index] === segment)
}

const DEFAULT_MATCHER = prismaClientModuleMatcher()

export function hasPrismaImport(
  imports: readonly ImportEdge[],
  filePath: string,
  matches: PrismaClientModuleMatcher = DEFAULT_MATCHER,
): boolean {
  return hasMatchingImport(imports, { plugin: EFFECTS_PRISMA_PLUGIN_NAME, filePath }, matches)
}

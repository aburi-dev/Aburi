import { readFile, realpath } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { AsyncMemo, describeJsonType, describeThrown, errorCode, stripUtf8Bom } from "@aburi/core"
import type { ImportResolver, ImportResolverContext, Logger } from "@aburi/types"
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser"

const CONFIG_FILE_NAMES = ["tsconfig.json", "jsconfig.json"]
const CONFIG_DIR = `\${configDir}`
const NODE_MODULES = "node_modules"
// EISDIR is what a `node_modules/<package>` candidate of `packageCandidates` gives.
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EISDIR"])
// A path `realpath` cannot follow for one of these is read as written, and the read reports it.
const UNFOLLOWED_CODES: ReadonlySet<string> = new Set([...ABSENT_CODES, "ELOOP"])

interface Declared<T> {
  readonly value: T
  /** The directory of the config that declares the option, which a relative value resolves against. */
  readonly dir: string
}

interface CompilerPaths {
  baseUrl?: Declared<string>
  paths?: Declared<readonly PathPattern[]>
}

interface RawConfig {
  readonly extends: readonly string[]
  readonly baseUrl: string | undefined
  readonly paths: readonly PathPattern[] | undefined
}

const UNUSABLE: RawConfig = { extends: [], baseUrl: undefined, paths: undefined }

type PathPattern =
  | { readonly kind: "exact"; readonly key: string; readonly substitutions: readonly string[] }
  | {
      readonly kind: "wildcard"
      readonly prefix: string
      readonly suffix: string
      readonly substitutions: readonly string[]
    }

interface PathMapping {
  readonly leafDir: string
  readonly baseUrl: string | null
  readonly paths: { readonly base: string; readonly patterns: readonly PathPattern[] } | null
}

interface ConfigReader {
  /** The config at `path` in the workspace, or null where there is none. */
  read(path: string): Promise<RawConfig | null>
  /** Where the package config found at `path` sits once its links are followed. */
  linkTarget(path: string): Promise<string>
  warn(message: string): void
  display(path: string): string
}

type Resolve = ImportResolver["resolve"]

export function createTsconfigResolver(ctx: ImportResolverContext): ImportResolver {
  let opened: Promise<Resolve> | undefined
  return {
    resolve(specifier, fromFile) {
      opened ??= openResolver(ctx)
      return opened.then((resolve) => resolve(specifier, fromFile))
    },
  }
}

// The roots are compared with paths whose links are followed, so their own are followed first.
async function openResolver(ctx: ImportResolverContext): Promise<Resolve> {
  const warned = new Set<string>()
  const warn = (message: string): void => {
    if (warned.has(message)) return
    warned.add(message)
    ctx.log.warn(message)
  }
  const realRoot = (path: string) => realPathOf(resolve(path), path, warn)
  const root = await realRoot(ctx.workspaceRoot)
  const installedRoot = ctx.installedRoot === undefined ? null : await realRoot(ctx.installedRoot)
  const reader = new ConfigFiles(root, installedRoot, ctx.log, warn)
  const scopes = new AsyncMemo<string, string | null>()
  const mappings = new AsyncMemo<string, PathMapping>()

  const nearestConfig = (directory: string): Promise<string | null> =>
    scopes.get(directory, async () => {
      for (const name of CONFIG_FILE_NAMES) {
        const path = join(directory, name)
        if ((await reader.read(path)) !== null) return path
      }
      const parent = dirname(directory)
      return directory === root || !isInside(root, parent) ? null : nearestConfig(parent)
    })

  const mappingOf = (configPath: string): Promise<PathMapping> =>
    mappings.get(configPath, async () =>
      buildMapping(await compilerPaths(configPath, [], reader), dirname(configPath)),
    )

  return async (specifier, fromFile) => {
    const directory = dirname(join(root, fromFile))
    if (!isInside(root, directory)) return []
    const configPath = await nearestConfig(directory)
    if (configPath === null) return []
    return mappedPaths(await mappingOf(configPath), specifier)
      .filter((path) => isInside(root, path))
      .map((path) => posixRelative(root, path))
  }
}

/**
 * The workspace's config files, as `tsc` would find them there. A workspace with an installed root
 * has none of its dependencies: a path through its `node_modules` it lacks is read at the same place
 * in the installed checkout, and one whose links lead to that checkout's own sources is read from
 * the workspace's copy, whose revision is the one being scanned.
 */
class ConfigFiles implements ConfigReader {
  readonly #root: string
  readonly #installedRoot: string | null
  readonly #log: Logger
  readonly #warn: (message: string) => void
  readonly #reals = new AsyncMemo<string, string>()
  readonly #reads = new AsyncMemo<string, RawConfig | null>()
  readonly #sources = new AsyncMemo<string, string | null>()
  readonly #ownCopies = new AsyncMemo<string, string | null>()

  constructor(
    root: string,
    installedRoot: string | null,
    log: Logger,
    warn: (message: string) => void,
  ) {
    this.#root = root
    this.#installedRoot = installedRoot
    this.#log = log
    this.#warn = warn
  }

  async read(path: string): Promise<RawConfig | null> {
    const source = await this.#source(path)
    return source === null ? null : this.#readAt(source)
  }

  // A package config is read where its links lead, as `tsc` reads it, so a workspace package linked
  // into `node_modules` resolves its relative values among its own sources.
  async linkTarget(path: string): Promise<string> {
    const real = await this.#real((await this.#source(path)) ?? path)
    return (await this.#ownCopy(real)) ?? real
  }

  warn(message: string): void {
    this.#warn(message)
  }

  // The installed checkout's files are named as the workspace's are, so a warning reads alike from
  // either checkout.
  display(path: string): string {
    if (isInside(this.#root, path)) return posixRelative(this.#root, path)
    const installedRoot = this.#installedRoot
    return installedRoot !== null && isInside(installedRoot, path)
      ? posixRelative(installedRoot, path)
      : path
  }

  #source(path: string): Promise<string | null> {
    return this.#sources.get(path, async () => {
      if ((await this.#readAt(path)) !== null) return path
      const installed = this.#installedDependency(path)
      if (installed === null || (await this.#readAt(installed)) === null) return null
      const real = await this.#real(installed)
      return (await this.#ownCopy(real)) ?? real
    })
  }

  #installedDependency(path: string): string | null {
    const installedRoot = this.#installedRoot
    if (installedRoot === null || !isInside(this.#root, path)) return null
    const rel = relative(this.#root, path)
    return throughNodeModules(rel) ? resolve(installedRoot, rel) : null
  }

  #ownCopy(real: string): Promise<string | null> {
    return this.#ownCopies.get(real, async () => {
      const installedRoot = this.#installedRoot
      if (installedRoot === null || !isInside(installedRoot, real)) return null
      const own = relative(installedRoot, real)
      if (throughNodeModules(own)) return null
      const copy = resolve(this.#root, own)
      if ((await this.#readAt(copy)) !== null) return copy
      this.#log.debug(
        `${posixRelative(installedRoot, real)} is not in the workspace, so the installed ` +
          `checkout's copy, ${real}, is read in its place.`,
      )
      return null
    })
  }

  // Keyed by where links lead, so a config reached both through a link and by its own path is read,
  // and warned about, once.
  async #readAt(path: string): Promise<RawConfig | null> {
    const real = await this.#real(path)
    return this.#reads.get(real, () => readConfig(real, this))
  }

  #real(path: string): Promise<string> {
    return this.#reals.get(path, () => realPathOf(path, this.display(path), this.#warn))
  }
}

// `realpath` fails on a missing file too; the read that follows tells absent from unreadable.
async function realPathOf(
  path: string,
  name: string,
  warn: (message: string) => void,
): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!UNFOLLOWED_CODES.has(errorCode(error) ?? "")) {
      warn(
        `${name} could not be followed to where its links lead (${describeThrown(error)}), ` +
          "so it is read where it is written.",
      )
    }
    return path
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/")
}

async function readConfig(path: string, reader: ConfigReader): Promise<RawConfig | null> {
  const name = reader.display(path)
  let text: string
  try {
    text = stripUtf8Bom(await readFile(path, "utf8"))
  } catch (error) {
    if (ABSENT_CODES.has(errorCode(error) ?? "")) return null
    reader.warn(
      `${name} could not be read (${describeThrown(error)}), so the path aliases it declares ` +
        "are not resolved.",
    )
    return UNUSABLE
  }
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true })
  const first = errors[0]
  if (first !== undefined) {
    reader.warn(
      `${name} is not valid JSON (${printParseErrorCode(first.error)} at ` +
        `${position(text, first.offset)}), so the path aliases it declares are not resolved.`,
    )
    return UNUSABLE
  }
  const config = isRecord(value) ? value : {}
  const written = config.extends
  const extendsList =
    typeof written === "string" ? [written] : Array.isArray(written) ? written : []
  const options = isRecord(config.compilerOptions) ? config.compilerOptions : {}
  return {
    extends: extendsList.filter((entry): entry is string => typeof entry === "string"),
    baseUrl: readBaseUrl(options.baseUrl, (problem) => reader.warn(`${name} ${problem}.`)),
    paths: readPaths(options.paths, (problem) => reader.warn(`${name} ${problem}.`)),
  }
}

function readBaseUrl(value: unknown, warn: (problem: string) => void): string | undefined {
  if (value === undefined || typeof value === "string") return value
  warn(
    `declares compilerOptions.baseUrl as ${describeJsonType(value)}, not a string, so it is ignored`,
  )
  return undefined
}

// `tsc` refuses each of these shapes, so a config holding one does not build as written.
function readPaths(value: unknown, warn: (problem: string) => void): PathPattern[] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    warn(
      `declares compilerOptions.paths as ${describeJsonType(value)}, not an object, so it maps nothing`,
    )
    return undefined
  }
  const patterns: PathPattern[] = []
  for (const [key, written] of Object.entries(value)) {
    if (!Array.isArray(written)) {
      warn(
        `declares paths["${key}"] as ${describeJsonType(written)}, not a list, so that key maps nothing`,
      )
      continue
    }
    const stars = countStars(key)
    if (stars > 1) {
      warn(`declares the paths key "${key}" with more than one "*", so it maps nothing`)
      continue
    }
    const substitutions: string[] = []
    for (const entry of written) {
      if (typeof entry !== "string") {
        warn(`declares a substitution for "${key}" as ${describeJsonType(entry)}, so it is skipped`)
      } else if (countStars(entry) > 1) {
        warn(
          `declares the substitution "${entry}" for "${key}" with more than one "*", so it is skipped`,
        )
      } else substitutions.push(entry)
    }
    const star = key.indexOf("*")
    patterns.push(
      stars === 0
        ? { kind: "exact", key, substitutions }
        : {
            kind: "wildcard",
            prefix: key.slice(0, star),
            suffix: key.slice(star + 1),
            substitutions,
          },
    )
  }
  return patterns
}

async function compilerPaths(
  configPath: string,
  chain: readonly string[],
  reader: ConfigReader,
): Promise<CompilerPaths> {
  const config = await reader.read(configPath)
  if (config === null) return {}
  const dir = dirname(configPath)
  const merged: CompilerPaths = {}
  for (const entry of config.extends) {
    const base = await locateExtended(entry, dir, reader)
    if (base === null) {
      reader.warn(
        `${reader.display(configPath)} extends "${entry}", but no config file was found for it, ` +
          "so the path aliases it would supply are not resolved.",
      )
      continue
    }
    if (base === configPath || chain.includes(base)) continue
    Object.assign(merged, await compilerPaths(base, [...chain, configPath], reader))
  }
  if (config.baseUrl !== undefined) merged.baseUrl = { value: config.baseUrl, dir }
  if (config.paths !== undefined) merged.paths = { value: config.paths, dir }
  return merged
}

// A package's `package.json` `exports` and `tsconfig` fields are not read, so a package that
// exposes its config only through them is not found.
async function locateExtended(
  entry: string,
  dir: string,
  reader: ConfigReader,
): Promise<string | null> {
  if (entry.startsWith("./") || entry.startsWith("../") || isAbsolute(entry)) {
    const path = resolve(dir, entry)
    return firstConfig(extname(path) === ".json" ? [path] : [path, `${path}.json`], reader)
  }
  const found = await firstConfig(packageCandidates(entry, dir), reader)
  return found === null ? null : reader.linkTarget(found)
}

function packageCandidates(entry: string, dir: string): string[] {
  const candidates: string[] = []
  for (let at = dir; ; at = dirname(at)) {
    const path = join(at, NODE_MODULES, entry)
    candidates.push(path, `${path}.json`, join(path, "tsconfig.json"))
    if (dirname(at) === at) return candidates
  }
}

async function firstConfig(
  candidates: readonly string[],
  reader: ConfigReader,
): Promise<string | null> {
  for (const candidate of candidates) {
    if ((await reader.read(candidate)) !== null) return candidate
  }
  return null
}

function throughNodeModules(relativePath: string): boolean {
  return relativePath.split(sep).includes(NODE_MODULES)
}

function buildMapping(options: CompilerPaths, leafDir: string): PathMapping {
  const baseUrl =
    options.baseUrl === undefined
      ? null
      : optionPath(options.baseUrl.value, options.baseUrl.dir, leafDir)
  const paths =
    options.paths === undefined
      ? null
      : { base: baseUrl ?? options.paths.dir, patterns: options.paths.value }
  return { leafDir, baseUrl, paths }
}

function mappedPaths(mapping: PathMapping, specifier: string): string[] {
  const out: string[] = []
  if (mapping.paths !== null) {
    for (const written of substitutionsFor(mapping.paths.patterns, specifier)) {
      out.push(optionPath(written, mapping.paths.base, mapping.leafDir))
    }
  }
  if (mapping.baseUrl !== null) out.push(resolve(mapping.baseUrl, specifier))
  return out
}

function substitutionsFor(patterns: readonly PathPattern[], specifier: string): readonly string[] {
  let best: { readonly substitutions: readonly string[]; prefix: string; star: string } | null =
    null
  for (const pattern of patterns) {
    if (pattern.kind === "exact") {
      if (pattern.key === specifier) return pattern.substitutions
      continue
    }
    const { prefix, suffix } = pattern
    const fits =
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    if (fits && (best === null || prefix.length > best.prefix.length)) {
      const star = specifier.slice(prefix.length, specifier.length - suffix.length)
      best = { substitutions: pattern.substitutions, prefix, star }
    }
  }
  if (best === null) return []
  const { star } = best
  return best.substitutions.map((substitution) => substitution.replace("*", () => star))
}

function optionPath(value: string, declaredDir: string, leafDir: string): string {
  return value.startsWith(CONFIG_DIR)
    ? join(leafDir, value.slice(CONFIG_DIR.length))
    : resolve(declaredDir, value)
}

function position(text: string, offset: number): string {
  const before = text.slice(0, offset)
  const lineStart = before.lastIndexOf("\n") + 1
  return `${before.split("\n").length}:${offset - lineStart + 1}`
}

function countStars(text: string): number {
  return text.split("*").length - 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

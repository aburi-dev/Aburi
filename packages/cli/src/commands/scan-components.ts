import {
  buildComponentAttribution,
  CoreError,
  type CoreErrorCode,
  compareCodeUnit,
  type DetectComponentsResult,
  type DetectManagersResult,
  describeThrown,
  detectComponents,
  detectManagers,
  languageFileDropPatterns,
  makeComponentId,
  makeLanguageId,
  NPM_MANIFEST,
  posixSpellingViolation,
  readWorkspacePackages,
  toDocumentPath,
  type WorkspacePackage,
} from "@aburi/core"
import type { Component, Config, IR, LanguagePlugin } from "@aburi/types"
import { CliError, errorMessage } from "../errors"
import { frameworkIdForPlugin } from "../plugin-catalog"
import type { LoadedPlugins } from "../plugin-loader"
import type {
  PackageInNoComponent,
  PluginNamedFramework,
  UnreadPackageManifest,
} from "./scan-report"

export function declaredComponents(config: Partial<Config>): Config["components"] | undefined {
  const declared = config.components
  return declared !== undefined && declared.length > 0 ? declared : undefined
}

export async function resolveManagers(
  config: Partial<Config>,
  workspaceRoot: string,
): Promise<DetectManagersResult> {
  try {
    return await detectManagers(workspaceRoot, { respectGitignore: config.respectGitignore })
  } catch (error) {
    throw isUnreadableTree(error) ? componentResolutionFailure(error) : error
  }
}

// The manager scan meets the tree before the census does, so a tree neither can read is reported
// alike whichever meets it. A manifest fault the manager scan meets keeps its exit 1.
export function isUnreadableTree(error: unknown): error is CoreError {
  return error instanceof CoreError && UNREADABLE_TREE_CODES.has(error.code)
}

export async function resolveComponents(
  config: Partial<Config>,
  workspaceRoot: string,
  languages: readonly LanguagePlugin[],
): Promise<DetectComponentsResult> {
  const declared = declaredComponents(config)
  try {
    if (declared !== undefined) {
      return { components: declared.map(componentFromConfig), ignoredPublicApi: [] }
    }
    return await detectComponents({
      workspaceRoot,
      ignore: [...(config.ignore ?? []), ...languageFileDropPatterns(languages)],
      respectGitignore: config.respectGitignore,
    })
  } catch (error) {
    throw componentResolutionFailure(error)
  }
}

export interface ResolvedWorkspacePackages {
  packages: WorkspacePackage[]
  unreadManifests: UnreadPackageManifest[]
  /** The roots of the workspace packages no Component holds. */
  rootsInNoComponent: string[]
}

export async function resolveWorkspacePackages(
  workspaceRoot: string,
  managers: DetectManagersResult,
  components: readonly Component[],
): Promise<ResolvedWorkspacePackages> {
  const attribute = buildComponentAttribution(components)
  const roots = [
    ...managers.workspaces.map((candidate) => candidate.relativeRoot),
    ...components.flatMap((component) => component.roots),
  ]
  const held = new Set<string>()
  const unheld = new Set<string>()
  for (const root of roots) {
    if (attribute(`${root}/${NPM_MANIFEST}`) === null) unheld.add(root)
    else held.add(root)
  }
  let packages: WorkspacePackage[]
  try {
    packages = await readWorkspacePackages(workspaceRoot, [...held])
  } catch (error) {
    throw componentResolutionFailure(error)
  }
  // A package no Component holds is the end of no edge, so a manifest that cannot be read costs
  // only its name, and the others are still read.
  const named = await Promise.all([...unheld].map((root) => readUnheldPackage(workspaceRoot, root)))
  return {
    packages: [...packages, ...named.flatMap((read) => read.packages)],
    unreadManifests: named.flatMap((read) => read.unreadManifests),
    rootsInNoComponent: [...unheld].sort(compareCodeUnit),
  }
}

/**
 * The workspace packages, among `roots`, that Symbols no Component holds came from, each Symbol
 * counted for the deepest root containing its file.
 */
export function packagesInNoComponent(
  symbols: IR["symbols"],
  roots: readonly string[],
): PackageInNoComponent[] {
  const deepestFirst = [...roots].sort((a, b) => b.length - a.length)
  const counts = new Map<string, number>()
  for (const symbol of symbols) {
    if (symbol.component !== null) continue
    const { file } = symbol.source
    const root = deepestFirst.find(
      (candidate) => candidate === "." || file === candidate || file.startsWith(`${candidate}/`),
    )
    if (root !== undefined) counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  return roots.flatMap((root) => {
    const count = counts.get(root)
    return count === undefined ? [] : [{ root, symbols: count }]
  })
}

async function readUnheldPackage(
  workspaceRoot: string,
  root: string,
): Promise<Omit<ResolvedWorkspacePackages, "rootsInNoComponent">> {
  try {
    return { packages: await readWorkspacePackages(workspaceRoot, [root]), unreadManifests: [] }
  } catch (error) {
    if (!(error instanceof CoreError) || error.code !== "workspace-manifest-malformed") {
      throw componentResolutionFailure(error)
    }
    return {
      packages: [],
      unreadManifests: [
        { manifestPath: `${root}/${NPM_MANIFEST}`, reason: describeThrown(error.cause ?? error) },
      ],
    }
  }
}

function componentFromConfig(entry: NonNullable<Config["components"]>[number]): Component {
  const languages = (entry.languages ?? []).map(makeLanguageId)
  const component: Component = {
    id: makeComponentId(entry.id),
    name: entry.name ?? entry.id,
    roots: entry.roots.map((root) => toDocumentPath(root, `components[id=${entry.id}] root`)),
    languages: languages.length > 0 ? languages : [makeLanguageId("ts")],
    description: entry.description ?? null,
  }
  if (entry.publicApi !== undefined && entry.publicApi.length > 0) {
    component.publicApi = entry.publicApi.map((pattern) =>
      assertSpelling(pattern, `components[id=${entry.id}] publicApi entry`),
    )
  }
  if (entry.frameworks !== undefined && entry.frameworks.length > 0) {
    component.frameworks = [...entry.frameworks]
  }
  return component
}

function assertSpelling(value: string, subject: string): string {
  const normalized = value.normalize("NFC")
  const violation = posixSpellingViolation(normalized, subject)
  if (violation !== null) throw new CoreError(violation.message, violation)
  return normalized
}

function componentResolutionFailure(error: unknown): CliError {
  const configFault = error instanceof CoreError && CONFIG_COMPONENT_ERROR_CODES.has(error.code)
  return new CliError(
    `Failed to resolve components: ${errorMessage(error)}`,
    configFault ? "config-error" : "runtime-error",
    { cause: error },
  )
}

const UNREADABLE_TREE_CODES: ReadonlySet<CoreErrorCode> = new Set<CoreErrorCode>([
  "scan-gitignore-unreadable",
  "scan-directory-unreadable",
])

const CONFIG_COMPONENT_ERROR_CODES: ReadonlySet<CoreErrorCode> = new Set<CoreErrorCode>([
  "invalid-component-id",
  "invalid-language-id",
  "non-posix-path",
  "workspace-manifest-malformed",
  "workspace-root-outside",
])

export function pluginNamedFrameworks(
  config: Partial<Config>,
  registry: LoadedPlugins["registry"],
): PluginNamedFramework[] {
  const found: PluginNamedFramework[] = []
  for (const component of declaredComponents(config) ?? []) {
    for (const value of component.frameworks ?? []) {
      if (registry.findFramework(value) !== null) continue
      const manifest = registry.listPlugins().find((plugin) => plugin.name === value)
      const firstParty = frameworkIdForPlugin(value)
      if (manifest !== undefined) {
        found.push({
          component: component.id,
          value,
          frameworkIds: [...manifest.provides.frameworks],
        })
      } else if (firstParty !== undefined) {
        found.push({ component: component.id, value, frameworkIds: [firstParty] })
      }
    }
  }
  return found
}

import { open } from "node:fs/promises"
import { extname, join, resolve } from "node:path"
import {
  CoreError,
  detectComponents,
  detectJsPackageManagerTool,
  detectManagers,
  type UnnameableRoot,
  type UnresolvedDeclaration,
} from "@aburi/core"
import { CONFIG_SCHEMA_URL, type Config } from "@aburi/types"
import { CliError, errorMessage } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { pathKind } from "../fs-probe"
import { outputIsADirectory, writeOutputFile } from "../output-file"
import {
  DEPENDENCY_TO_EFFECTS_PLUGIN,
  FRAMEWORK_TO_PLUGIN,
  LANGUAGE_TO_PLUGIN,
} from "../plugin-catalog"
import { workspacePackageUrl } from "../plugin-loader"
import { resolveWorkspaceRoot } from "../workspace-root"
import { isUnreadableTree } from "./scan-components"

const CONFIG_ARTEFACT = "the config"

export interface InitOptions {
  respectGitignore?: boolean
  cwd?: string
  output?: string
  force?: boolean
  withSuggestions?: boolean
}

export interface InitReport {
  outputPath: string
  workspaceRoot: string
  detectedManagers: string[]
  detectedLanguages: string[]
  detectedFrameworks: string[]
  /** The effects plugins written to `effects`, for the dependencies the workspace's manifests name. */
  effectsPlugins: string[]
  componentCount: number
  suggestedPlugins: readonly string[]
  /** The command that installs `suggestedPlugins` at the workspace root, or `null` when it names none. */
  installCommand: string | null
  unmappedLanguages: readonly string[]
  unresolvedDeclarations: readonly UnresolvedDeclaration[]
  unnameableRoots: readonly UnnameableRoot[]
  fellBackToSingleComponent: boolean
  unmappedFrameworks: readonly string[]
  overwrote: boolean
  exitCode: ExitCode
}

export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)
  const outputPath = resolve(cwd, options.output ?? "aburi.json")

  const existing = await pathKind(outputPath)
  if (existing === "directory") {
    throw outputIsADirectory({ command: "init", artefact: CONFIG_ARTEFACT, path: outputPath })
  }
  if (existing === "file" && !options.force) {
    throw new CliError(
      `${outputPath} already exists. Use --force to overwrite or pass --output <path> to write elsewhere.`,
      "input-error",
    )
  }

  const { respectGitignore } = options
  const managers = await detectManagers(workspaceRoot, { respectGitignore }).catch(
    (error: unknown) => {
      throw isUnreadableTree(error) ? detectionFailure(error) : error
    },
  )
  const { components, dependencyNames } = await detectComponents({
    workspaceRoot,
    respectGitignore,
  }).catch((error: unknown) => {
    throw detectionFailure(error)
  })

  const languageSet = new Set<string>()
  const frameworkSet = new Set<string>()
  for (const component of components) {
    for (const language of component.languages) languageSet.add(language)
    for (const framework of component.frameworks ?? []) frameworkSet.add(framework)
  }

  const effects = pluginRefsFor(new Set(dependencyNames), DEPENDENCY_TO_EFFECTS_PLUGIN)
  const suggestions = options.withSuggestions
    ? uninstalledPackages(workspaceRoot, suggestPluginsFor(languageSet, frameworkSet, effects))
    : []
  const command =
    suggestions.length === 0
      ? null
      : await installCommand(
          workspaceRoot,
          suggestions,
          managers.managers.some((manager) => manager.tool === "yarn"),
        )
  const contents = renderConfig({
    languages: pluginRefsFor(languageSet, LANGUAGE_TO_PLUGIN),
    frameworks: pluginRefsFor(frameworkSet, FRAMEWORK_TO_PLUGIN),
    effects,
    components: components.map((component) => ({
      id: component.id,
      name: component.name,
      roots: [...component.roots].sort(),
      languages: [...component.languages].sort(),
      frameworks: [...(component.frameworks ?? [])].sort(),
    })),
    // JSON has no comments, and a `.json` file is read by more than Aburi.
    banner: command !== null && extname(outputPath).toLowerCase() === ".jsonc" ? command : null,
  })

  await writeOutputFile({ command: "init", artefact: CONFIG_ARTEFACT, path: outputPath }, contents)

  return {
    outputPath,
    workspaceRoot,
    detectedManagers: managers.managers.map((manager) => manager.tool),
    detectedLanguages: [...languageSet].sort(),
    detectedFrameworks: [...frameworkSet].sort(),
    effectsPlugins: effects,
    componentCount: components.length,
    suggestedPlugins: suggestions,
    installCommand: command,
    unmappedLanguages: unmappedIds(languageSet, LANGUAGE_TO_PLUGIN),
    unmappedFrameworks: unmappedIds(frameworkSet, FRAMEWORK_TO_PLUGIN),
    unresolvedDeclarations: managers.unresolved,
    unnameableRoots: managers.unnameableRoots,
    fellBackToSingleComponent: managers.workspaces.length === 0,
    overwrote: existing === "file",
    exitCode: EXIT.SUCCESS,
  }
}

function pluginRefsFor(
  detected: ReadonlySet<string>,
  table: ReadonlyMap<string, string>,
): string[] {
  const out = new Set<string>()
  for (const id of detected) {
    const ref = table.get(id)
    if (ref !== undefined) out.add(ref)
  }
  return [...out].sort()
}

function suggestPluginsFor(
  languages: ReadonlySet<string>,
  frameworks: ReadonlySet<string>,
  effects: readonly string[],
): string[] {
  return [
    ...pluginRefsFor(languages, LANGUAGE_TO_PLUGIN),
    ...pluginRefsFor(frameworks, FRAMEWORK_TO_PLUGIN),
    ...effects,
  ].map((name) => `@aburi/${name}`)
}

function uninstalledPackages(workspaceRoot: string, packages: readonly string[]): string[] {
  return packages.filter((name) => !installedFrom(workspaceRoot, name))
}

/**
 * Looked up where a scan looks first. A plugin the CLI carries beside it is still suggested: the
 * config goes wherever the project goes, and the CLIs that read it there need the project to
 * hold the plugin.
 */
function installedFrom(directory: string, name: string): boolean {
  return workspacePackageUrl(name, directory) !== null
}

async function installCommand(
  workspaceRoot: string,
  packages: readonly string[],
  yarnWorkspace: boolean,
): Promise<string> {
  const names = packages.join(" ")
  // pnpm refuses to add to a workspace's root package unless told that is the one meant.
  if ((await pathKind(join(workspaceRoot, "pnpm-workspace.yaml"))) === "file") {
    return `pnpm add -D -w ${names}`
  }
  switch (await detectJsPackageManagerTool(workspaceRoot)) {
    case "pnpm":
      return `pnpm add -D ${names}`
    case "yarn":
      // Yarn 1 refuses to add to a workspace root without -W, which later versions do not accept.
      return yarnWorkspace && (await isYarnClassic(workspaceRoot))
        ? `yarn add -D -W ${names}`
        : `yarn add -D ${names}`
    case "bun":
      return `bun add -d ${names}`
    default:
      return `npm install -D ${names}`
  }
}

const YARN_CLASSIC_HEADER = /^# yarn lockfile v1$/m

async function isYarnClassic(workspaceRoot: string): Promise<boolean> {
  const lockfile = await open(join(workspaceRoot, "yarn.lock"))
  try {
    const { buffer, bytesRead } = await lockfile.read(Buffer.alloc(512), 0, 512, 0)
    return YARN_CLASSIC_HEADER.test(buffer.toString("utf8", 0, bytesRead))
  } finally {
    await lockfile.close()
  }
}

function unmappedIds(detected: ReadonlySet<string>, table: ReadonlyMap<string, string>): string[] {
  return [...detected].filter((id) => !table.has(id)).sort()
}

interface RenderedConfigInput {
  languages: readonly string[]
  frameworks: readonly string[]
  effects: readonly string[]
  components: readonly {
    id: string
    name: string
    roots: readonly string[]
    languages: readonly string[]
    frameworks: readonly string[]
  }[]
  banner: string | null
}

function renderConfig(input: RenderedConfigInput): string {
  const config: Partial<Config> & { $schema: string } = {
    $schema: CONFIG_SCHEMA_URL,
    languages: [...input.languages],
    frameworks: [...input.frameworks],
    effects: [...input.effects],
    components: input.components.map((component) => ({
      id: component.id,
      name: component.name,
      roots: [...component.roots],
      languages: [...component.languages],
      frameworks: [...component.frameworks],
    })),
  }
  const json = JSON.stringify(config, null, 2)
  if (input.banner === null) return `${json}\n`
  return `${json.replace("{\n", `{\n  // Suggested install: ${input.banner}\n`)}\n`
}

function detectionFailure(error: unknown): CliError {
  return new CliError(
    `Failed to detect components: ${errorMessage(error)}${gitignoreEscapeHatch(error)}`,
    isUnreadableTree(error) ? "runtime-error" : "config-error",
    { cause: error },
  )
}

function gitignoreEscapeHatch(error: unknown): string {
  if (!(error instanceof CoreError) || error.code !== "scan-gitignore-unreadable") return ""
  return " Pass --no-respect-gitignore to detect components without reading it."
}

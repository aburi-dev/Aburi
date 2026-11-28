import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, posix, relative, resolve, sep } from "node:path"
import { recordingLogger } from "@aburi/test-support"
import { CONFIG_SCHEMA_URL, type IR } from "@aburi/types"
import {
  DEFAULT_OUTPUT_DIRNAME,
  DIFF_FULL_MD_FILENAME,
  DIFF_JSON_FILENAME,
  DIFF_MD_FILENAME,
  runScan,
  type ScanOptions,
  type ScanReport,
} from "../src"

export const TYPESCRIPT: { languages: string[] } = { languages: ["lang-typescript"] }

/** A path under the directory a command writes to when neither a flag nor the config names one. */
export function defaultOutput(root: string, ...segments: string[]): string {
  return resolve(root, DEFAULT_OUTPUT_DIRNAME, ...segments)
}

export async function writeFileAt(root: string, rel: string, content: string): Promise<void> {
  const path = resolve(root, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
}

export async function writeConfig(
  directory: string,
  config: Record<string, unknown>,
  filename = "aburi.json",
): Promise<void> {
  await writeFileAt(directory, filename, JSON.stringify({ $schema: CONFIG_SCHEMA_URL, ...config }))
}

export async function writePackageJson(
  directory: string,
  manifest: Record<string, unknown> = { name: "fixture", private: true },
): Promise<void> {
  await writeFileAt(directory, "package.json", JSON.stringify(manifest))
}

/**
 * What a revision diff here starts from, uncommitted: a TypeScript workspace named `demo`, or
 * after its directory without the manifest, that keeps `out/`, where the report goes, out of git.
 */
export async function writeDiffWorkspace(
  directory: string,
  sources: Readonly<Record<string, string>>,
  { manifest = true }: { manifest?: boolean } = {},
): Promise<void> {
  if (manifest) await writePackageJson(directory, { name: "demo", private: true })
  await writeConfig(directory, TYPESCRIPT)
  await writeFileAt(directory, ".gitignore", "out/\n")
  for (const [path, source] of Object.entries(sources)) await writeFileAt(directory, path, source)
}

/** A one-package TypeScript workspace whose only source declares nothing. */
export async function writeTypeScriptWorkspace(directory: string, name: string): Promise<void> {
  await writePackageJson(directory, { name, private: true })
  await writeConfig(directory, TYPESCRIPT)
  await writeFileAt(directory, "src/quiet.ts", "// declares nothing\n")
}

/** A pnpm workspace at `root` whose one package is `pkgs/app`, holding `alpha()`. */
export async function writeMonorepo(root: string): Promise<string> {
  await writeFileAt(root, "pnpm-workspace.yaml", "packages:\n  - 'pkgs/*'\n")
  await writePackageJson(root, { name: "root", private: true })
  return writeMonorepoPackage(root, "app", ["alpha"])
}

/** A package `pkgs/<name>` of the monorepo at `root`, whose `src/a.ts` declares `functions`. */
export async function writeMonorepoPackage(
  root: string,
  name: string,
  functions: readonly string[],
): Promise<string> {
  const directory = resolve(root, "pkgs", name)
  await writePackageJson(directory, { name })
  const source = functions.map((fn) => `export function ${fn}() { return 1 }\n`).join("")
  await writeFileAt(directory, "src/a.ts", source)
  return directory
}

/** `aburi scan` of the workspace at `root`, to `out/` as JSON, and the warnings it said. */
export async function scanSaying(
  root: string,
  options: ScanOptions = {},
): Promise<{ report: ScanReport; warnings: string[] }> {
  const log = recordingLogger()
  const report = await runScan({
    cwd: root,
    outputDir: resolve(root, "out"),
    format: "json",
    ...options,
    incidents: { warn: log.warn },
  })
  return { report, warnings: log.warnings }
}

export async function writeIRs(
  directory: string,
  base: IR,
  head: IR,
): Promise<{ base: string; head: string }> {
  const paths = { base: resolve(directory, "base.json"), head: resolve(directory, "head.json") }
  await writeFile(paths.base, JSON.stringify(base), "utf8")
  await writeFile(paths.head, JSON.stringify(head), "utf8")
  return paths
}

/** The report an earlier `aburi diff` left in each of `directories`, by path relative to `root`. */
export async function writeEarlierReports(
  root: string,
  directories: readonly string[],
): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const directory of directories) {
    for (const filename of [DIFF_JSON_FILENAME, DIFF_MD_FILENAME, DIFF_FULL_MD_FILENAME]) {
      const path = posix.join(directory, filename)
      const content = `an earlier ${path}\n`
      await writeFileAt(root, path, content)
      files[path] = content
    }
  }
  return files
}

/** Every file and directory under `root`, by `/`-separated path relative to it, sorted. */
export async function listTree(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true }))
    .map((entry) => entry.replaceAll(sep, "/"))
    .sort()
}

/** Every file under `root`, by `/`-separated path relative to it, with its contents. */
export async function filesUnder(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = resolve(entry.parentPath, entry.name)
    files[relative(root, path).replaceAll(sep, "/")] = await readFile(path, "utf8")
  }
  return files
}

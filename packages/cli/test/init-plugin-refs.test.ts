import { readFile } from "node:fs/promises"
import { DRIZZLE_MODULES_LIST } from "@aburi/effects-drizzle"
import { NEST_CQRS_MODULE, NEST_EMITTER_MODULES_LIST } from "@aburi/effects-nest"
import { PRISMA_CLIENT_MODULES_LIST } from "@aburi/effects-prisma"
import { TRPC_CLIENT_MODULES_LIST } from "@aburi/effects-trpc"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { runInit } from "../src"
import { DEPENDENCY_TO_EFFECTS_PLUGIN } from "../src/plugin-catalog"
import { writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("init-plugin-refs")

interface WrittenConfig {
  languages: string[]
  frameworks: string[]
  effects: string[]
  components: { languages: string[]; frameworks: string[] }[]
}

async function writeApp(
  dependencies: Record<string, string>,
  field = "dependencies",
): Promise<void> {
  await writePackageJson(workspace.root, { name: "app", private: true, [field]: dependencies })
  await workspace.writeSource("src/a.ts", "export function alpha() {}\n")
}

async function initWithDependencies(dependencies: Record<string, string>, field?: string) {
  await writeApp(dependencies, field)
  const report = await runInit({ cwd: workspace.root })
  const config = JSON.parse(await readFile(report.outputPath, "utf8")) as WrittenConfig
  return { report, config }
}

/** A pnpm workspace of `apps/*` whose root manifest is `root`, and whose `apps/api` is `api`. */
async function writeAppsWorkspace(root: Record<string, unknown>, api: string): Promise<void> {
  await workspace.writeSource("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n")
  await writePackageJson(workspace.root, { name: "root", private: true, ...root })
  await writeFileAt(workspace.root, "apps/api/package.json", api)
  await writeFileAt(workspace.root, "apps/api/src/a.ts", "export function alpha() {}\n")
}

describe("aburi init — the plugins it writes", () => {
  it.each([
    ["@nestjs/core", "nestjs", "framework-nestjs"],
    ["@trpc/server", "trpc", "framework-trpc"],
  ])(
    "writes the plugin for %s at the top level and its detector id inside components[]",
    async (dependency, framework, plugin) => {
      const { report, config } = await initWithDependencies({ [dependency]: "^10.0.0" })

      expect(config.languages).toEqual(["lang-typescript"])
      expect(config.frameworks).toEqual([plugin])
      expect(config.components).toEqual([
        expect.objectContaining({ languages: ["ts"], frameworks: [framework] }),
      ])
      expect(report.detectedLanguages).toEqual(["ts"])
      expect(report.detectedFrameworks).toEqual([framework])
      expect(report.unmappedFrameworks).toEqual([])
    },
  )

  it.each([
    ["@prisma/client", "effects-prisma"],
    ["drizzle-orm", "effects-drizzle"],
    ["@nestjs/event-emitter", "effects-nest"],
    ["eventemitter2", "effects-nest"],
    ["@nestjs/cqrs", "effects-nest"],
    ["@trpc/client", "effects-trpc"],
    ["@trpc/react-query", "effects-trpc"],
    ["@trpc/next", "effects-trpc"],
    ["@trpc/tanstack-react-query", "effects-trpc"],
  ])("writes the effects plugin for a dependency on %s, %s", async (dependency, plugin) => {
    const { report, config } = await initWithDependencies({ [dependency]: "^1.0.0" })

    expect(config.effects).toEqual([plugin])
    expect(report.effectsPlugins).toEqual([plugin])
  })

  it.each([
    [
      { "@prisma/client": "^5.0.0", "@nestjs/event-emitter": "^2.0.0" },
      ["effects-nest", "effects-prisma"],
    ],
    [{ "@nestjs/cqrs": "^10.0.0", eventemitter2: "^6.0.0" }, ["effects-nest"]],
    [{ "@trpc/server": "^11.0.0", express: "^4.0.0" }, []],
  ])(
    "writes each effects plugin once, sorted, for the dependencies %o",
    async (dependencies, plugins) => {
      const { report, config } = await initWithDependencies(dependencies)

      expect(config.effects).toEqual(plugins)
      expect(report.effectsPlugins).toEqual(plugins)
    },
  )

  it.each(["devDependencies", "peerDependencies", "optionalDependencies"])(
    "reads a dependency declared in %s",
    async (field) => {
      const { report } = await initWithDependencies({ "drizzle-orm": "^0.30.0" }, field)

      expect(report.effectsPlugins).toEqual(["effects-drizzle"])
    },
  )

  it.each([
    ["a workspace package's manifest", {}, { devDependencies: { "drizzle-orm": "^0.30.0" } }],
    ["the root manifest alone", { devDependencies: { "drizzle-orm": "^0.30.0" } }, {}],
  ])("reads a dependency in %s of a workspace", async (_, root, api) => {
    await writeAppsWorkspace(root, JSON.stringify({ name: "api", private: true, ...api }))

    const report = await runInit({ cwd: workspace.root })

    expect(report.effectsPlugins).toEqual(["effects-drizzle"])
  })

  it("reads a workspace package's manifest that opens with a byte order mark", async () => {
    const api = {
      name: "api",
      dependencies: { "@nestjs/core": "^10.0.0", "@prisma/client": "^5.0.0" },
    }
    await writeAppsWorkspace({}, `\uFEFF${JSON.stringify(api)}`)

    const report = await runInit({ cwd: workspace.root })

    expect(report.detectedFrameworks).toEqual(["nestjs"])
    expect(report.effectsPlugins).toEqual(["effects-prisma"])
  })

  it("suggests the language plugin, then the framework plugins, then the effects plugins", async () => {
    await writeApp({ "@nestjs/core": "^10.0.0", "@prisma/client": "^5.0.0" })

    const report = await runInit({ cwd: workspace.root, withSuggestions: true })

    expect(report.suggestedPlugins).toEqual([
      "@aburi/lang-typescript",
      "@aburi/framework-nestjs",
      "@aburi/effects-prisma",
    ])
  })

  it("reports a framework it has no plugin for instead of writing a ref nothing resolves", async () => {
    const { report, config } = await initWithDependencies({ svelte: "^4.0.0" })

    expect(config.frameworks).toEqual([])
    expect(report.detectedFrameworks).toContain("svelte")
    expect(report.unmappedFrameworks).toEqual(["svelte"])
    expect(report.unmappedLanguages).toEqual([])
  })

  it("reports a language it has no plugin for, which leaves `languages` empty", async () => {
    await writePackageJson(workspace.root, { name: "app", private: true })
    for (let i = 0; i < 15; i++) {
      await workspace.writeSource(`src/m${i}.py`, "def f():\n    return 1\n")
    }

    const report = await runInit({ cwd: workspace.root })
    const config = JSON.parse(await readFile(report.outputPath, "utf8")) as WrittenConfig

    expect(report.unmappedLanguages).toEqual(["py"])
    expect(config.languages).toEqual([])
    expect(config.components[0]?.languages).toContain("py")
  })
})

describe("the dependencies aburi init writes an effects plugin for", () => {
  it.each<[string, readonly string[]]>([
    ["effects-prisma", PRISMA_CLIENT_MODULES_LIST],
    ["effects-drizzle", DRIZZLE_MODULES_LIST],
    ["effects-nest", [...NEST_EMITTER_MODULES_LIST, NEST_CQRS_MODULE]],
    ["effects-trpc", TRPC_CLIENT_MODULES_LIST],
  ])("hold every package %s's import gate opens on", (plugin, modules) => {
    expect(modules.map((name) => [name, DEPENDENCY_TO_EFFECTS_PLUGIN.get(name)])).toEqual(
      modules.map((name) => [name, plugin]),
    )
  })
})

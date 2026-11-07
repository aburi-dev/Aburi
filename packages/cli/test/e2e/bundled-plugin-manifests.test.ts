import { PLUGIN_SCHEMA_URL } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { loadPlugins } from "../../src"
import { FRAMEWORK_TO_PLUGIN, LANGUAGE_TO_PLUGIN } from "../../src/plugin-catalog"

type PluginField = "languages" | "frameworks" | "effects"

const listed = (field: PluginField, names: Iterable<string>) =>
  [...new Set(names)].map((name) => [field, name] as const)

const BUNDLED = [
  ...listed("languages", LANGUAGE_TO_PLUGIN.values()),
  ...listed("frameworks", FRAMEWORK_TO_PLUGIN.values()),
  ...listed("effects", ["effects-drizzle", "effects-nest", "effects-prisma", "effects-trpc"]),
]

describe("a bundled plugin, loaded the way aburi scan loads it", () => {
  it.each(
    BUNDLED,
  )("in %s, %s names the plugin schema by the URL Aburi writes", async (field, name) => {
    const loaded = await loadPlugins({ config: { [field]: [name] }, workspaceRoot: process.cwd() })
    const [plugin] = loaded[field]
    expect(plugin?.manifest.name).toBe(name)
    expect(plugin?.manifest.$schema).toBe(PLUGIN_SCHEMA_URL)
  })
})

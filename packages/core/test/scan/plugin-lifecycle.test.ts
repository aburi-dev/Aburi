import { noopRegistry, recordingLogger } from "@aburi/test-support"
import type { EffectPlugin, FrameworkPlugin, LanguagePlugin, PluginContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CoreError } from "../../src"
import {
  extractorPool,
  oneSymbolPerFile,
  scanStubs,
  stubEffectsPlugin,
  stubFrameworkPlugin,
  useStubWorkspace,
} from "../fixtures/plugins"

const workspace = useStubWorkspace("plugin-lifecycle")

type Role = "lang" | "framework" | "effects"

interface Lineup {
  languages: LanguagePlugin[]
  frameworks: FrameworkPlugin[]
  effects: EffectPlugin[]
  calls: string[]
  contexts: PluginContext[]
}

/** One plugin of each role, each recording its lifecycle calls and the files it parses. */
function lineup(faults: Partial<Record<Role, { init?: Error; cleanup?: Error }>> = {}): Lineup {
  const calls: string[] = []
  const contexts: PluginContext[] = []
  const lifecycle = (role: Role) => ({
    init: async (ctx: PluginContext) => {
      calls.push(`init ${role}`)
      contexts.push(ctx)
      const fault = faults[role]?.init
      if (fault !== undefined) throw fault
    },
    cleanup: async () => {
      calls.push(`cleanup ${role}`)
      const fault = faults[role]?.cleanup
      if (fault !== undefined) throw fault
    },
  })
  return {
    languages: [
      oneSymbolPerFile({
        ...lifecycle("lang"),
        parseFile: async (file) => {
          calls.push(`parse ${file.path}`)
          return { tree: {}, errors: [], imports: [] }
        },
      }),
    ],
    frameworks: [stubFrameworkPlugin("framework-stub", lifecycle("framework"))],
    effects: [{ ...stubEffectsPlugin("effects-stub", () => null), ...lifecycle("effects") }],
    calls,
    contexts,
  }
}

describe("the plugin lifecycle of a scan", () => {
  it("initializes every plugin before the first file and cleans each up after the last, newest first", async () => {
    const { calls, contexts, ...plugins } = lineup()
    const result = await scanStubs(workspace.root, plugins)

    expect(calls).toEqual([
      "init lang",
      "init framework",
      "init effects",
      "parse a.stub",
      "parse bad.stub",
      "parse c.stub",
      "cleanup effects",
      "cleanup framework",
      "cleanup lang",
    ])
    expect(contexts.map((ctx) => ctx.workspaceRoot)).toEqual(Array(3).fill(workspace.root))
    expect(result.ir.stats.parsedFiles).toBe(3)
  })

  it("stops at a plugin whose init fails, cleaning up only the plugins initialized before it", async () => {
    const {
      calls,
      contexts: _,
      ...plugins
    } = lineup({
      framework: { init: new Error("python3 is not on PATH") },
    })
    const scanning = scanStubs(workspace.root, plugins)

    await expect(scanning).rejects.toThrow(CoreError)
    await expect(scanning).rejects.toMatchObject({
      code: "plugin-init-failed",
      value: "framework-stub",
      message: 'Plugin "framework-stub" failed to initialize: python3 is not on PATH',
    })
    expect(calls).toEqual(["init lang", "init framework", "cleanup lang"])
  })

  it("cleans up every plugin when a fault in the plugin set ends the scan", async () => {
    const { calls, contexts: _, ...plugins } = lineup()
    const [language] = plugins.languages
    const misconfigured: LanguagePlugin = {
      ...(language as LanguagePlugin),
      parseFile: async () => {
        throw Object.assign(new Error("lang-stub emits an undeclared effect"), {
          code: "vocab-undeclared",
        })
      },
    }

    await expect(
      scanStubs(workspace.root, { ...plugins, languages: [misconfigured] }),
    ).rejects.toMatchObject({ code: "vocab-undeclared" })
    expect(calls.slice(-3)).toEqual(["cleanup effects", "cleanup framework", "cleanup lang"])
  })

  it("warns of a cleanup that fails, cleans up the rest and keeps the scan's result", async () => {
    const {
      calls,
      contexts: _,
      ...plugins
    } = lineup({
      framework: { cleanup: new Error("the parser process would not exit") },
    })
    const logger = recordingLogger()
    const result = await scanStubs(workspace.root, { ...plugins, logger })

    expect(result.ir.stats.parsedFiles).toBe(3)
    expect(calls.slice(-3)).toEqual(["cleanup effects", "cleanup framework", "cleanup lang"])
    expect(logger.warnings).toContain(
      'Plugin "framework-stub" failed to clean up: the parser process would not exit',
    )
  })

  it("calls none of the plugins it was handed when a parse pool extracts on plugins of its own", async () => {
    const handed = lineup()
    const { languages, frameworks, effects, calls } = lineup()
    const result = await scanStubs(workspace.root, {
      languages: handed.languages,
      frameworks: handed.frameworks,
      effects: handed.effects,
      parsePool: extractorPool(
        1,
        () => ({ languages, frameworks, effects, registry: noopRegistry }),
        () => 0,
      ),
    })

    expect(result.ir.stats.parsedFiles).toBe(3)
    expect(handed.calls).toEqual([])
    expect(calls).toEqual(["parse a.stub", "parse bad.stub", "parse c.stub"])
  })

  it("initializes and cleans up once a plugin object listed twice", async () => {
    const { calls, contexts: _, effects, ...plugins } = lineup()
    await scanStubs(workspace.root, { ...plugins, effects: [...effects, ...effects] })

    expect(calls.filter((call) => call.endsWith("effects"))).toEqual([
      "init effects",
      "cleanup effects",
    ])
  })

  it.each<["init" | "cleanup", unknown, string]>([
    ["init", true, "a boolean"],
    ["cleanup", null, "null"],
  ])(
    "refuses a plugin whose %s is %o before any plugin is initialized",
    async (member, value, described) => {
      const { calls, contexts: _, ...plugins } = lineup()
      const [effects] = plugins.effects
      const misshapen = { ...(effects as EffectPlugin), [member]: value } as EffectPlugin

      await expect(
        scanStubs(workspace.root, { ...plugins, effects: [misshapen] }),
      ).rejects.toMatchObject({
        code: "scan-plugin-misconfigured",
        value: "effects-stub",
        message: `Plugin "effects-stub" sets ${member} to ${described}, not a function: leave it out, or make it an async function.`,
      })
      expect(calls).toEqual([])
    },
  )

  it("scans with a plugin written without init or cleanup", async () => {
    const { init: _init, cleanup: _cleanup, ...bare } = oneSymbolPerFile()
    const result = await scanStubs(workspace.root, { languages: [bare] })

    expect(result.ir.stats.parsedFiles).toBe(3)
  })
})

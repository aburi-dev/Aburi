import {
  decorator,
  importEdge,
  recordingLogger,
  spend,
  useScratchWorkspace,
} from "@aburi/test-support"
import type { Decorator, ImportEdge, ImportResolver, LanguagePlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { splitAliasedImportName } from "../../src"
import {
  fileCandidate,
  scanStubs,
  stubFrameworkPlugin,
  stubLanguagePlugin,
} from "../fixtures/plugins"

const workspace = useScratchWorkspace("import-origins")

/** What a `.stub` file holds: its import edges, and the decorators of the one Symbol it declares. */
interface Module {
  imports?: readonly ImportEdge[]
  decorators?: readonly Decorator[]
}

type Modules = Readonly<Record<string, Module>>
type Aliases = Readonly<Record<string, readonly string[]>>

const CONSUMER = "src/app.stub"
const BARREL = "libs/common/index.stub"
const ALIASES: Aliases = {
  "@app/common": [BARREL],
  "@app/fallback": ["libs/missing.stub", BARREL],
}
const decorated = [decorator({ name: "Decorate" })]
const importsDecorate = (source: string): Module => ({
  imports: [named(source, "Decorate")],
  decorators: decorated,
})

/** An import that binds names and republishes none of them. */
function named(source: string, ...symbols: string[]): ImportEdge {
  return importEdge({ source, symbols })
}

/** `export { … } from source`, each entry written `name` or `name as exported`. */
function reexporting(source: string, ...entries: string[]): ImportEdge {
  const bindings = entries.map(splitAliasedImportName)
  return importEdge({
    source,
    symbols: bindings.map((binding) => binding.imported),
    reexports: bindings.map((binding) => ({ imported: binding.imported, exported: binding.local })),
  })
}

/** `export * as exported from source`. */
function namespaceReexport(source: string, exported: string): ImportEdge {
  return importEdge({ source, symbols: "*", reexports: [{ imported: "*", exported }] })
}

interface Recorder {
  parsed: string[]
  released: unknown[]
  resolversCreated: number
}

const newRecorder = (): Recorder => ({ parsed: [], released: [], resolversCreated: 0 })

interface ModuleLanguage {
  recorder?: Recorder
  resolve?: (specifier: string) => Promise<readonly string[]>
  createResolver?: () => ImportResolver
  /** A file whose parse throws. */
  unparsable?: string
  /** A file whose every parse takes this long. */
  slow?: { readonly path: string; readonly ms: number }
}

function moduleLanguage(options: ModuleLanguage = {}): LanguagePlugin {
  const recorder = options.recorder ?? newRecorder()
  const resolve = options.resolve ?? (async (specifier: string) => ALIASES[specifier] ?? [])
  const read = (content: string): Module => JSON.parse(content) as Module
  return stubLanguagePlugin({
    parseFile: async (file) => {
      recorder.parsed.push(file.path)
      if (file.path === options.unparsable) throw new Error("grammar crashed")
      if (file.path === options.slow?.path) spend(options.slow.ms)
      return {
        tree: { file: file.path },
        errors: [],
        imports: [...(read(file.content).imports ?? [])],
      }
    },
    releaseTree: (tree) => {
      recorder.released.push(tree)
    },
    extractSymbols: (_tree, ctx) => [
      fileCandidate(ctx.file.path, { decorators: [...(read(ctx.file.content).decorators ?? [])] }),
    ],
    createImportResolver: () => {
      recorder.resolversCreated++
      return options.createResolver === undefined ? { resolve } : options.createResolver()
    },
  })
}

async function writeModules(modules: Modules): Promise<void> {
  for (const [path, module] of Object.entries(modules)) {
    await workspace.writeSource(path, JSON.stringify(module))
  }
}

/** The import edges each file's framework classification was handed, by file. */
async function importsSeen(
  modules: Modules,
  language: LanguagePlugin = moduleLanguage(),
  logger = recordingLogger(),
): Promise<Map<string, readonly ImportEdge[]>> {
  await writeModules(modules)
  const seen = new Map<string, readonly ImportEdge[]>()
  const framework = stubFrameworkPlugin("framework-stub", {
    classifySymbol: (_symbol, ctx) => {
      seen.set(ctx.file.path, ctx.imports)
      return null
    },
  })
  await scanStubs(workspace.root, { languages: [language], frameworks: [framework], logger })
  return seen
}

function originsOf(imports: readonly ImportEdge[] | undefined): [string, object | null][] {
  return (imports ?? []).map((edge) => [
    edge.source,
    edge.origins === undefined ? null : Object.fromEntries(edge.origins),
  ])
}

describe("scan — where a decorator's imported name is declared", () => {
  it.each<[string, Modules, [string, object | null][]]>([
    [
      "a path alias to a barrel that re-exports a package",
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: { imports: [reexporting("@vendor/kit", "Decorate")] },
      },
      [["@app/common", { Decorate: "@vendor/kit" }]],
    ],
    [
      "a relative barrel two re-exports deep",
      {
        [CONSUMER]: importsDecorate("./barrel.stub"),
        "src/barrel.stub": { imports: [reexporting("./inner.stub", "Decorate")] },
        "src/inner.stub": { imports: [reexporting("@vendor/kit", "Decorate")] },
      },
      [["./barrel.stub", { Decorate: "@vendor/kit" }]],
    ],
    [
      "a decorator renamed on import, keyed by the name the barrel exports",
      {
        [CONSUMER]: {
          imports: [named("@app/common", "Decorate as D")],
          decorators: [decorator({ name: "D" })],
        },
        [BARREL]: { imports: [reexporting("@vendor/kit", "Decorate")] },
      },
      [["@app/common", { Decorate: "@vendor/kit" }]],
    ],
    [
      "a namespace import a qualified decorator reads through",
      {
        [CONSUMER]: {
          imports: [importEdge({ source: "@app/common", symbols: "*", namespaceBinding: "ns" })],
          decorators: [decorator({ name: "Decorate", qualifier: "ns" })],
        },
        [BARREL]: { imports: [reexporting("@vendor/kit", "Decorate")] },
      },
      [["@app/common", { Decorate: "@vendor/kit" }]],
    ],
    [
      "a barrel that re-exports another name as the imported one",
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: { imports: [reexporting("@vendor/kit", "Inner as Decorate")] },
      },
      [["@app/common", { Decorate: "@vendor/kit" }]],
    ],
    [
      "the edge that exports the name, wherever it sits among the barrel's edges",
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: {
          imports: [
            reexporting("@vendor/other", "Decorate as Other"),
            reexporting("@vendor/kit", "Decorate"),
          ],
        },
      },
      [["@app/common", { Decorate: "@vendor/kit" }]],
    ],
    [
      "an import the barrel republishes in an export clause",
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: {
          imports: [
            importEdge({
              source: "@vendor/kit",
              symbols: ["Decorate"],
              reexports: [{ imported: "Decorate", exported: "Decorate" }],
            }),
          ],
        },
      },
      [["@app/common", { Decorate: "@vendor/kit" }]],
    ],
    [
      "a namespace a barrel re-exports from a package, which a qualified decorator reads",
      {
        [CONSUMER]: {
          imports: [named("@app/common", "kit")],
          decorators: [decorator({ name: "Decorate", qualifier: "kit" })],
        },
        [BARREL]: { imports: [namespaceReexport("@vendor/kit", "kit")] },
      },
      [["@app/common", { kit: "@vendor/kit" }]],
    ],
    [
      "the first path the resolver gives that the workspace holds",
      {
        [CONSUMER]: importsDecorate("@app/fallback"),
        [BARREL]: { imports: [reexporting("@vendor/kit", "Decorate")] },
      },
      [["@app/fallback", { Decorate: "@vendor/kit" }]],
    ],
  ])("follows %s", async (_case, modules, expected) => {
    const seen = await importsSeen(modules)
    expect(originsOf(seen.get(CONSUMER))).toEqual(expected)
  })

  it.each<[string, Modules]>([
    [
      "a barrel that re-exports the name under another one",
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: { imports: [reexporting("@vendor/kit", "Decorate as Other")] },
      },
    ],
    [
      "a barrel that imports the name only for its own use",
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: { imports: [named("@vendor/kit", "Decorate")] },
      },
    ],
    [
      "a barrel that reaches the name only through `export *`",
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: { imports: [importEdge({ source: "@vendor/kit", symbols: "*" })] },
      },
    ],
    [
      "a barrel that declares the name itself",
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: { imports: [reexporting("@vendor/kit", "Other")] },
      },
    ],
    [
      "a namespace a barrel re-exports from the workspace, whose member is not followed",
      {
        [CONSUMER]: {
          imports: [named("@app/common", "kit")],
          decorators: [decorator({ name: "Decorate", qualifier: "kit" })],
        },
        [BARREL]: { imports: [namespaceReexport("./own.stub", "kit")] },
        "libs/common/own.stub": { imports: [reexporting("@vendor/kit", "Decorate")] },
      },
    ],
    [
      "a re-export of a relative module the workspace does not hold",
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: { imports: [reexporting("./missing.stub", "Decorate")] },
      },
    ],
    [
      "two barrels re-exporting the name from each other",
      {
        [CONSUMER]: importsDecorate("./a.stub"),
        "src/a.stub": { imports: [reexporting("./b.stub", "Decorate")] },
        "src/b.stub": { imports: [reexporting("./a.stub", "Decorate")] },
      },
    ],
    ["a specifier the language maps nowhere", { [CONSUMER]: importsDecorate("@vendor/kit") }],
    [
      "an `origins` the language plugin wrote, which only the scan sets",
      {
        [CONSUMER]: {
          imports: [{ ...named("@vendor/kit", "Decorate"), origins: { Decorate: "@forged/kit" } }],
          decorators: decorated,
        } as unknown as Module,
      },
    ],
  ])("records no origin for %s", async (_case, modules) => {
    const seen = await importsSeen(modules)
    expect(originsOf(seen.get(CONSUMER)).map(([, origins]) => origins)).toEqual([null])
  })

  it("follows only the names a decorator uses", async () => {
    const seen = await importsSeen({
      [CONSUMER]: {
        imports: [named("@vendor/kit", "Decorate"), named("@app/common", "helper")],
        decorators: decorated,
      },
      [BARREL]: { imports: [reexporting("@vendor/util", "helper")] },
    })
    expect(originsOf(seen.get(CONSUMER))).toEqual([
      ["@vendor/kit", null],
      ["@app/common", null],
    ])
  })

  it.each<[string, string, number]>([
    ["after the files that import it, once beyond its own turn", "z/barrel.stub", 2],
    ["before the files that import it, only in its own turn", "a/barrel.stub", 1],
  ])("parses a barrel discovered %s, and frees each tree", async (_case, barrel, parses) => {
    const recorder = newRecorder()
    const consumer = importsDecorate("@app/shared")
    const seen = await importsSeen(
      {
        "b.stub": consumer,
        "c.stub": consumer,
        "d.stub": consumer,
        [barrel]: { imports: [reexporting("@vendor/kit", "Decorate")] },
      },
      moduleLanguage({
        recorder,
        resolve: async (specifier) => (specifier === "@app/shared" ? [barrel] : []),
      }),
    )

    expect(recorder.parsed.filter((path) => path === barrel)).toHaveLength(parses)
    expect(recorder.released).toHaveLength(recorder.parsed.length)
    expect(recorder.resolversCreated).toBe(1)
    for (const file of ["b.stub", "c.stub", "d.stub"]) {
      expect(originsOf(seen.get(file))).toEqual([["@app/shared", { Decorate: "@vendor/kit" }]])
    }
  })

  it("asks for no resolver and parses no barrel when no framework plugin would read an origin", async () => {
    const recorder = newRecorder()
    await writeModules({
      [CONSUMER]: {
        imports: [named("@app/common", "Decorate"), named("./z-barrel.stub", "Decorate")],
        decorators: decorated,
      },
      [BARREL]: { imports: [reexporting("@vendor/kit", "Decorate")] },
      "src/z-barrel.stub": { imports: [reexporting("@vendor/kit", "Decorate")] },
    })
    await scanStubs(workspace.root, { languages: [moduleLanguage({ recorder })] })

    expect(recorder.resolversCreated).toBe(0)
    expect(recorder.parsed).toEqual([BARREL, CONSUMER, "src/z-barrel.stub"])
  })

  it("charges a barrel's parse to the barrel, not to the file whose chain reached it", async () => {
    await writeModules({
      [CONSUMER]: importsDecorate("./z-barrel.stub"),
      "src/z-barrel.stub": { imports: [reexporting("@vendor/kit", "Decorate")] },
    })
    const framework = stubFrameworkPlugin()
    const result = await scanStubs(workspace.root, {
      config: { parseTimeoutMs: 100 },
      languages: [moduleLanguage({ slow: { path: "src/z-barrel.stub", ms: 150 } })],
      frameworks: [framework],
    })

    expect(result.skipped.map((file) => [file.path, file.reason])).toEqual([
      ["src/z-barrel.stub", "parse-timeout"],
    ])
  })

  it("ends a chain without an origin where the barrel it reaches cannot be parsed", async () => {
    const logger = recordingLogger()
    const seen = await importsSeen(
      { [CONSUMER]: importsDecorate("./z-barrel.stub"), "src/z-barrel.stub": { imports: [] } },
      moduleLanguage({ unparsable: "src/z-barrel.stub" }),
      logger,
    )

    expect(originsOf(seen.get(CONSUMER))).toEqual([["./z-barrel.stub", null]])
    expect(logger.debugs.map((entry) => entry.message)).toContainEqual(
      expect.stringMatching(/src\/z-barrel\.stub gave no import edges: grammar crashed/),
    )
  })
})

describe("scan — a language's import resolver that fails", () => {
  it("warns at the first failure, logs the rest at debug, and counts them at the end", async () => {
    const logger = recordingLogger()
    const consumer = {
      imports: [named("@app/common", "Decorate"), named("@app/other", "Decorate as D")],
      decorators: [...decorated, decorator({ name: "D" })],
    }
    const seen = await importsSeen(
      { [CONSUMER]: consumer, "src/second.stub": consumer },
      moduleLanguage({
        resolve: async () => {
          throw new Error("tsconfig unreadable")
        },
      }),
      logger,
    )

    expect(originsOf(seen.get(CONSUMER))).toEqual([
      ["@app/common", null],
      ["@app/other", null],
    ])
    expect(logger.warnings).toEqual([
      expect.stringMatching(
        /^Plugin lang-stub: its import resolver threw on "@app\/common".*tsconfig unreadable/,
      ),
      "Plugin lang-stub: its import resolver failed 4 times over this run.",
    ])
    expect(
      logger.debugs.filter((entry) => entry.message.includes("tsconfig unreadable")),
    ).toHaveLength(3)
  })

  it("records no origin past a hop the resolver failed on, mid-chain", async () => {
    const logger = recordingLogger()
    const seen = await importsSeen(
      {
        [CONSUMER]: importsDecorate("@app/common"),
        [BARREL]: { imports: [reexporting("@app/inner", "Decorate")] },
      },
      moduleLanguage({
        resolve: async (specifier) => {
          if (specifier === "@app/inner") throw new Error("alias table corrupt")
          return ALIASES[specifier] ?? []
        },
      }),
      logger,
    )

    expect(originsOf(seen.get(CONSUMER))).toEqual([["@app/common", null]])
    expect(logger.warnings).toEqual([expect.stringMatching(/"@app\/inner".*alias table corrupt/)])
  })

  it.each<[string, () => ImportResolver, RegExp]>([
    [
      "throws",
      () => {
        throw new Error("no tsconfig support")
      },
      /^Plugin lang-stub: creating its import resolver threw: no tsconfig support\./,
    ],
    [
      "returns no resolver",
      () => undefined as unknown as ImportResolver,
      /^Plugin lang-stub: createImportResolver returned no resolver: expected an object with a resolve method, got undefined\./,
    ],
  ])("warns once when creating the resolver %s, and records no origin", async (_case, createResolver, warning) => {
    const logger = recordingLogger()
    const seen = await importsSeen(
      {
        [CONSUMER]: importsDecorate("@app/common"),
        "src/second.stub": importsDecorate("@app/common"),
        [BARREL]: { imports: [reexporting("@vendor/kit", "Decorate")] },
      },
      moduleLanguage({ createResolver }),
      logger,
    )

    expect(originsOf(seen.get(CONSUMER))).toEqual([["@app/common", null]])
    expect(logger.warnings).toEqual([expect.stringMatching(warning)])
  })
})

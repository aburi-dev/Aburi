import {
  importEdge,
  makeCall,
  reexportEdge,
  starReexportEdge,
  useScratchWorkspace,
} from "@aburi/test-support"
import type { CallCandidate, ImportEdge, LanguagePlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { scanStubs, stubEffectsPlugin, stubFrameworkPlugin } from "../fixtures/plugins"
import {
  type Aliases,
  CONSUMER,
  moduleLanguage,
  named,
  newRecorder,
  type StubModule,
  type StubModules,
  writeModules,
} from "../fixtures/stub-modules"

const workspace = useScratchWorkspace("effect-imports")

const ALIASES: Aliases = { "@app/db": ["libs/db/index.stub"] }
const WORKSPACE_PACKAGES = [
  { name: "@acme/db", root: "packages/db", entry: { main: "./index.stub" } },
]

interface Seen {
  /** The edges each file's calls were classified against, by file. */
  readonly imports: Map<string, readonly ImportEdge[]>
  /** The targets the effect plugin was asked about, by file. */
  readonly asked: Map<string, string[]>
  /** The edges each file's framework classification was handed, by file. */
  readonly frameworkImports: Map<string, readonly ImportEdge[]>
}

async function scanModules(
  modules: StubModules,
  language: LanguagePlugin = moduleLanguage({ aliases: ALIASES }),
): Promise<Seen> {
  await writeModules(workspace, modules)
  const seen: Seen = { imports: new Map(), asked: new Map(), frameworkImports: new Map() }
  const effects = stubEffectsPlugin("effects-stub", (call, ctx) => {
    seen.imports.set(ctx.file.path, ctx.file.imports)
    const asked = seen.asked.get(ctx.file.path) ?? []
    asked.push(call.target)
    seen.asked.set(ctx.file.path, asked)
    return null
  })
  const framework = stubFrameworkPlugin("framework-stub", {
    classifySymbol: (_symbol, ctx) => {
      seen.frameworkImports.set(ctx.file.path, ctx.imports)
      return null
    },
  })
  await scanStubs(workspace.root, {
    languages: [language],
    frameworks: [framework],
    effects: [effects],
    workspacePackages: WORKSPACE_PACKAGES,
  })
  return seen
}

const ANY_CALL = makeCall({ target: "client.user.findMany" })

function consumerOf(...imports: ImportEdge[]): StubModule {
  return { imports, calls: [ANY_CALL] }
}

function upstreamOf(edges: readonly ImportEdge[] | undefined): [string, object | null][] {
  return (edges ?? []).map((edge) => [
    edge.source,
    edge.upstream === undefined ? null : Object.fromEntries(edge.upstream),
  ])
}

describe("scan — what the modules a file imports from import, as an effect plugin reads them", () => {
  it.each<[string, StubModules, [string, object | null][]]>([
    [
      "a relative module that declares the name",
      {
        [CONSUMER]: consumerOf(named("./db.stub", "client")),
        "src/db.stub": { imports: [named("@vendor/orm", "Client"), named("./env.stub", "env")] },
      },
      [["./db.stub", { client: ["./env.stub", "@vendor/orm"] }]],
    ],
    [
      "a name renamed on import, keyed as the module exports it",
      {
        [CONSUMER]: consumerOf(named("./db.stub", "client as db")),
        "src/db.stub": { imports: [named("@vendor/orm", "Client")] },
      },
      [["./db.stub", { client: ["@vendor/orm"] }]],
    ],
    [
      "a barrel's re-export, through to the module that declares the name",
      {
        [CONSUMER]: consumerOf(named("./index.stub", "client")),
        "src/index.stub": { imports: [reexportEdge("./db.stub", "client")] },
        "src/db.stub": { imports: [named("@vendor/orm", "Client")] },
      },
      [["./index.stub", { client: ["@vendor/orm"] }]],
    ],
    [
      "a barrel's `export *`, through to the target that exports the name",
      {
        [CONSUMER]: consumerOf(named("./index.stub", "client")),
        "src/index.stub": {
          imports: [starReexportEdge("./cache.stub"), starReexportEdge("./db.stub")],
        },
        "src/cache.stub": { imports: [named("@vendor/kv", "Store")], exports: ["cache"] },
        "src/db.stub": { imports: [named("@vendor/orm", "Client")], exports: ["client"] },
      },
      [["./index.stub", { client: ["@vendor/orm"] }]],
    ],
    [
      "a barrel's own imports, where no `export *` target shows the name",
      {
        [CONSUMER]: consumerOf(named("./index.stub", "client")),
        "src/index.stub": {
          imports: [starReexportEdge("./db.stub"), named("@vendor/log", "log")],
        },
        "src/db.stub": { imports: [named("@vendor/orm", "Client")] },
      },
      [["./index.stub", { client: ["./db.stub", "@vendor/log"] }]],
    ],
    [
      "a barrel's own imports, where its `export *` targets lead back to it",
      {
        [CONSUMER]: consumerOf(named("./a.stub", "client")),
        "src/a.stub": { imports: [starReexportEdge("./b.stub"), named("@vendor/log", "log")] },
        "src/b.stub": { imports: [starReexportEdge("./a.stub")] },
      },
      [["./a.stub", { client: ["./b.stub", "@vendor/log"] }]],
    ],
    [
      "an `export *` target whose own `export *` passes on what a package exports",
      {
        [CONSUMER]: consumerOf(named("./index.stub", "Client")),
        "src/index.stub": { imports: [starReexportEdge("./orm.stub")] },
        "src/orm.stub": { imports: [starReexportEdge("@vendor/orm")] },
      },
      [["./index.stub", { Client: ["@vendor/orm"] }]],
    ],
    [
      "a namespace import of an `export *` barrel, under `*` with the barrel's own imports",
      {
        [CONSUMER]: consumerOf(
          importEdge({ source: "./index.stub", symbols: "*", namespaceBinding: "lib" }),
        ),
        "src/index.stub": { imports: [starReexportEdge("./db.stub")] },
        "src/db.stub": { imports: [named("@vendor/orm", "Client")], exports: ["client"] },
      },
      [["./index.stub", { "*": ["./db.stub"] }]],
    ],
    [
      "a re-export that ends at a package, which becomes the name's origin",
      {
        [CONSUMER]: consumerOf(named("./index.stub", "Client")),
        "src/index.stub": { imports: [reexportEdge("@vendor/orm", "Client")] },
      },
      [["./index.stub", { Client: ["@vendor/orm"] }]],
    ],
    [
      "a namespace import, under `*`",
      {
        [CONSUMER]: consumerOf(
          importEdge({ source: "./db.stub", symbols: "*", namespaceBinding: "db" }),
        ),
        "src/db.stub": { imports: [named("@vendor/orm", "Client")] },
      },
      [["./db.stub", { "*": ["@vendor/orm"] }]],
    ],
    [
      "a default import, under `default`",
      {
        [CONSUMER]: consumerOf(named("./db.stub", "default as db")),
        "src/db.stub": { imports: [named("@vendor/orm", "Client")] },
      },
      [["./db.stub", { default: ["@vendor/orm"] }]],
    ],
    [
      "a path alias the language maps into the workspace",
      {
        [CONSUMER]: consumerOf(named("@app/db", "client")),
        "libs/db/index.stub": { imports: [named("@vendor/orm", "Client")] },
      },
      [["@app/db", { client: ["@vendor/orm"] }]],
    ],
    [
      "a workspace package's name",
      {
        [CONSUMER]: consumerOf(named("@acme/db", "client")),
        "packages/db/index.stub": { imports: [named("@vendor/orm", "Client")] },
      },
      [["@acme/db", { client: ["@vendor/orm"] }]],
    ],
    [
      "nothing for a package outside the workspace, or a module the workspace does not hold",
      { [CONSUMER]: consumerOf(named("@vendor/orm", "Client"), named("./missing.stub", "client")) },
      [
        ["@vendor/orm", null],
        ["./missing.stub", null],
      ],
    ],
    [
      "nothing for two barrels re-exporting the name from each other",
      {
        [CONSUMER]: consumerOf(named("./a.stub", "client")),
        "src/a.stub": { imports: [reexportEdge("./b.stub", "client")] },
        "src/b.stub": { imports: [reexportEdge("./a.stub", "client")] },
      },
      [["./a.stub", null]],
    ],
  ])("follows %s", async (_case, modules, expected) => {
    const seen = await scanModules(modules)
    expect(upstreamOf(seen.imports.get(CONSUMER))).toEqual(expected)
  })

  const BROKEN = "src/broken.stub"

  it.each<[string, StubModules]>([
    [
      "comes from a module that cannot be parsed",
      { [CONSUMER]: consumerOf(named("./broken.stub", "client")), [BROKEN]: {} },
    ],
    [
      "may come from a barrel's `export *` target that cannot be parsed",
      {
        [CONSUMER]: consumerOf(named("./index.stub", "client")),
        "src/index.stub": {
          imports: [starReexportEdge("./broken.stub"), starReexportEdge("./cache.stub")],
        },
        [BROKEN]: {},
        "src/cache.stub": { imports: [named("@vendor/kv", "Store")], exports: ["cache"] },
      },
    ],
  ])("follows nothing for a name that %s", async (_case, modules) => {
    const seen = await scanModules(
      modules,
      moduleLanguage({ aliases: ALIASES, unparsable: BROKEN }),
    )
    expect(upstreamOf(seen.imports.get(CONSUMER)).map(([, upstream]) => upstream)).toEqual([null])
  })

  it("keeps the origin a re-export chain ends at on the edge", async () => {
    const seen = await scanModules({
      [CONSUMER]: consumerOf(named("./index.stub", "Client")),
      "src/index.stub": { imports: [reexportEdge("@vendor/orm", "Client")] },
    })
    const [edge] = seen.imports.get(CONSUMER) ?? []
    expect(edge?.origins).toEqual(new Map([["Client", "@vendor/orm"]]))
  })

  it("hands a framework plugin the file's own edges", async () => {
    const seen = await scanModules({
      [CONSUMER]: consumerOf(named("./db.stub", "client")),
      "src/db.stub": { imports: [named("@vendor/orm", "Client")] },
    })
    expect(upstreamOf(seen.frameworkImports.get(CONSUMER))).toEqual([["./db.stub", null]])
  })
})

describe("scan — a call of a method the workspace declares on the receiver's class", () => {
  const create = (receiverType: string): readonly CallCandidate[] => [
    makeCall({ target: "this.users.create", receiverType }),
  ]

  it.each<[string, StubModules]>([
    [
      "a class the file imports",
      {
        [CONSUMER]: { imports: [named("./users.stub", "Users")], calls: create("Users") },
        "src/users.stub": { classes: [{ name: "Users", members: ["create"] }] },
      },
    ],
    [
      "a class the file declares",
      { [CONSUMER]: { classes: [{ name: "Users", members: ["create"] }], calls: create("Users") } },
    ],
    [
      "a class the module exports as its default",
      {
        [CONSUMER]: {
          imports: [named("./users.stub", "default as Users")],
          calls: create("Users"),
        },
        "src/users.stub": {
          classes: [{ name: "UsersService", members: ["create"], exported: "default" }],
        },
      },
    ],
    [
      "a class the module exports under the name an export clause gives it",
      {
        [CONSUMER]: { imports: [named("./users.stub", "Users")], calls: create("Users") },
        "src/users.stub": {
          classes: [{ name: "Service", members: ["create"], exported: { as: "Users" } }],
        },
      },
    ],
    [
      "a class imported under another name",
      {
        [CONSUMER]: { imports: [named("./users.stub", "Users as Repo")], calls: create("Repo") },
        "src/users.stub": { classes: [{ name: "Users", members: ["create"] }] },
      },
    ],
    [
      "a class a barrel re-exports by name",
      {
        [CONSUMER]: { imports: [named("./index.stub", "Users")], calls: create("Users") },
        "src/index.stub": { imports: [reexportEdge("./users.stub", "Users")] },
        "src/users.stub": { classes: [{ name: "Users", members: ["create"] }] },
      },
    ],
    [
      "a class a barrel's `export *` leads to",
      {
        [CONSUMER]: { imports: [named("./index.stub", "Users")], calls: create("Users") },
        "src/index.stub": { imports: [starReexportEdge("./users.stub")] },
        "src/users.stub": { classes: [{ name: "Users", members: ["create"] }] },
      },
    ],
    [
      "a class read through a namespace import",
      {
        [CONSUMER]: {
          imports: [importEdge({ source: "./users.stub", symbols: "*", namespaceBinding: "u" })],
          calls: create("u.Users"),
        },
        "src/users.stub": { classes: [{ name: "Users", members: ["create"] }] },
      },
    ],
    [
      "a method a workspace class it extends declares",
      {
        [CONSUMER]: { imports: [named("./users.stub", "Users")], calls: create("Users") },
        "src/users.stub": {
          imports: [named("./base.stub", "Base")],
          classes: [{ name: "Users", superclass: "Base", members: ["find"] }],
        },
        "src/base.stub": { classes: [{ name: "Base", members: ["create"] }] },
      },
    ],
  ])("leaves %s to call resolution", async (_case, modules) => {
    const seen = await scanModules(modules)
    expect(seen.asked.get(CONSUMER)).toBeUndefined()
  })

  it.each<[string, StubModules]>([
    [
      "a class whose method comes from a package class it extends",
      {
        [CONSUMER]: { imports: [named("./users.stub", "Users")], calls: create("Users") },
        "src/users.stub": {
          imports: [named("@vendor/orm", "Client")],
          classes: [{ name: "Users", superclass: "Client", members: ["connect"] }],
        },
      },
    ],
    [
      "a type the workspace declares that is no class",
      {
        [CONSUMER]: { imports: [named("./users.stub", "Users")], calls: create("Users") },
        "src/users.stub": { imports: [named("@vendor/orm", "Client")] },
      },
    ],
    [
      "a class that declares other methods",
      {
        [CONSUMER]: { imports: [named("./users.stub", "Users")], calls: create("Users") },
        "src/users.stub": { classes: [{ name: "Users", members: ["find"] }] },
      },
    ],
    [
      "two classes that extend each other",
      {
        [CONSUMER]: {
          classes: [
            { name: "A", superclass: "B" },
            { name: "B", superclass: "A" },
          ],
          calls: create("A"),
        },
      },
    ],
  ])("asks the effect plugins about %s", async (_case, modules) => {
    const seen = await scanModules(modules)
    expect(seen.asked.get(CONSUMER)).toEqual(["this.users.create"])
  })
})

describe("scan — a module the chain reaches, read for its edges and its declarations", () => {
  it.each<[string, StubModules, string]>([
    [
      "the module a receiver's class is read from",
      {
        [CONSUMER]: {
          imports: [named("./users.stub", "Users")],
          calls: [makeCall({ target: "this.users.create", receiverType: "Users" })],
        },
        "src/users.stub": {
          imports: [named("@vendor/orm", "Client")],
          classes: [{ name: "Users", members: ["find"] }],
        },
      },
      "src/users.stub",
    ],
    [
      "an `export *` target",
      {
        [CONSUMER]: consumerOf(named("./index.stub", "client")),
        "src/index.stub": { imports: [starReexportEdge("./db.stub")] },
        "src/db.stub": { imports: [named("@vendor/orm", "Client")], exports: ["client"] },
      },
      "src/db.stub",
    ],
  ])("parses %s once for the chain, and once in its own turn", async (_case, modules, module) => {
    const recorder = newRecorder()
    await scanModules(modules, moduleLanguage({ aliases: ALIASES, recorder }))
    expect(recorder.parsed.filter((path) => path === module)).toHaveLength(2)
  })
})

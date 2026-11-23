import {
  importEdge,
  makeCall,
  reexportEdge,
  starReexportEdge,
  useScratchWorkspace,
} from "@aburi/test-support"
import type { CallCandidate, ImportEdge, LanguagePlugin, SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  fileCandidate,
  scanStubs,
  stubCandidate,
  stubEffectsPlugin,
  stubFrameworkPlugin,
  stubLanguagePlugin,
} from "../fixtures/plugins"

const workspace = useScratchWorkspace("effect-imports")

interface DeclaredClass {
  readonly name: string
  readonly superclass?: string
  readonly members?: readonly string[]
}

/** What a `.stub` file holds: its import edges, the classes it declares and the calls its body makes. */
interface Module {
  readonly imports?: readonly ImportEdge[]
  readonly classes?: readonly DeclaredClass[]
  readonly calls?: readonly CallCandidate[]
}

type Modules = Readonly<Record<string, Module>>

const CONSUMER = "src/app.stub"
const ALIASES: Readonly<Record<string, readonly string[]>> = { "@app/db": ["libs/db/index.stub"] }
const WORKSPACE_PACKAGES = [
  { name: "@acme/db", root: "packages/db", entry: { main: "./index.stub" } },
]

const read = (content: string): Module => JSON.parse(content) as Module

function classCandidates(file: string, declared: DeclaredClass): SymbolCandidate[] {
  const members = declared.members ?? []
  return [
    stubCandidate(declared.name, {
      file,
      kind: "class",
      ...(declared.superclass === undefined
        ? {}
        : { superclass: declared.superclass, instanceMembers: [...members] }),
    }),
    ...members.map((member) =>
      stubCandidate(`${declared.name}.${member}`, { file, kind: "method" }),
    ),
  ]
}

function moduleLanguage(): LanguagePlugin {
  return stubLanguagePlugin({
    parseFile: async (file) => ({
      tree: { file: file.path },
      errors: [],
      imports: [...(read(file.content).imports ?? [])],
    }),
    extractSymbols: (_tree, ctx) => [
      fileCandidate(ctx.file.path),
      ...(read(ctx.file.content).classes ?? []).flatMap((declared) =>
        classCandidates(ctx.file.path, declared),
      ),
    ],
    walkBody: (symbol, ctx) => ({
      rules: [],
      calls: symbol.kind === "function" ? [...(read(ctx.file.content).calls ?? [])] : [],
    }),
    createImportResolver: () => ({ resolve: async (specifier) => ALIASES[specifier] ?? [] }),
  })
}

interface Seen {
  /** The edges each file's calls were classified against, by file. */
  readonly imports: Map<string, readonly ImportEdge[]>
  /** The targets the effect plugin was asked about, by file. */
  readonly asked: Map<string, string[]>
  /** The edges each file's framework classification was handed, by file. */
  readonly frameworkImports: Map<string, readonly ImportEdge[]>
}

async function scanModules(modules: Modules): Promise<Seen> {
  for (const [path, module] of Object.entries(modules)) {
    await workspace.writeSource(path, JSON.stringify(module))
  }
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
    languages: [moduleLanguage()],
    frameworks: [framework],
    effects: [effects],
    workspacePackages: WORKSPACE_PACKAGES,
  })
  return seen
}

const ANY_CALL = makeCall({ target: "client.user.findMany" })

function consumerOf(...imports: ImportEdge[]): Module {
  return { imports, calls: [ANY_CALL] }
}

function named(source: string, ...symbols: string[]): ImportEdge {
  return importEdge({ source, symbols })
}

function upstreamOf(edges: readonly ImportEdge[] | undefined): [string, object | null][] {
  return (edges ?? []).map((edge) => [
    edge.source,
    edge.upstream === undefined ? null : Object.fromEntries(edge.upstream),
  ])
}

describe("scan — what the modules a file imports from import, as an effect plugin reads them", () => {
  it.each<[string, Modules, [string, object | null][]]>([
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
      "a barrel's `export *`, beside the barrel's own imports",
      {
        [CONSUMER]: consumerOf(named("./index.stub", "client")),
        "src/index.stub": { imports: [starReexportEdge("./db.stub")] },
        "src/db.stub": { imports: [named("@vendor/orm", "Client")] },
      },
      [["./index.stub", { client: ["./db.stub", "@vendor/orm"] }]],
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

  it.each<[string, Modules]>([
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

  it.each<[string, Modules]>([
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

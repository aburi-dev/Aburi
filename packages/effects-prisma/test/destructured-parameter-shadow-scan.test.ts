import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { irSchemaViolations, symbolById, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("destructured-parameter-shadow")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] })

const SHADOWED = [
  "plain",
  "withDeps",
  "withTuple",
  "renamed",
  "defaulted",
  "nested",
  "rest",
  "restName",
  "arrow",
  "Handler.handle",
  "localArrow",
  "localFunction",
  "block",
  "caught",
  "forOf",
  "callback",
  "POST",
  "PUT",
  "Route.handle",
]

const REPO = [
  'import { PrismaClient } from "@prisma/client"',
  "const prisma = new PrismaClient()",
  "",
  "export async function save(total: number) {",
  "  await prisma.invoice.create({ data: { total } })",
  "}",
  "",
].join("\n")

describe("scan — a parameter or a local named after the import shadows it", () => {
  beforeEach(async () => {
    await workspace.writeSource("src/repo.ts", REPO)
    await workspace.writeSource(
      "src/handler.ts",
      [
        'import { save } from "./repo"',
        'import { withAuth } from "./auth"',
        "",
        "type Deps = { save: (total: number) => Promise<void> }",
        "",
        'export async function plain(save: Deps["save"]) { await save(1) }',
        "export async function withDeps({ save }: Deps) { await save(2) }",
        'export async function withTuple([save]: [Deps["save"]]) { await save(3) }',
        'export async function renamed({ persist: save }: { persist: Deps["save"] }) { await save(4) }',
        "export async function defaulted({ save = async (n: number) => {} }: Partial<Deps> = {}) { await save(5) }",
        "export async function nested({ deps: { save } }: { deps: Deps }) { await save(6) }",
        'export async function rest(...[save]: [Deps["save"]]) { await save(7) }',
        "export async function restName(...save: any) { await save(11) }",
        "export const arrow = async ({ save }: Deps) => { await save(8) }",
        "export class Handler { async handle({ save }: any) { await save(9) } }",
        "export async function localArrow() { const save = async (n: number) => n; await save(12) }",
        "export async function localFunction() { async function save(n: number) { return n }; await save(13) }",
        "export async function block() { { const save = async (n: number) => n; await save(14) } }",
        "export async function caught() { try {} catch (save: any) { await save(15) } }",
        'export async function forOf(list: Deps["save"][]) { for (const save of list) await save(16) }',
        'export async function callback(list: Deps["save"][]) { list.forEach((save) => save(17)) }',
        "export const POST = withAuth(async ({ save }: any) => { await save(18) })",
        "export const PUT = withAuth(async (save: any) => { await save(19) })",
        "export class Route { handle = withAuth(async ({ save }: any) => { await save(20) }) }",
        "export async function direct() { await save(10) }",
        "",
      ].join("\n"),
    )
  })

  it.each(SHADOWED)("%s leaves `save` unresolved and takes no effect", async (qname) => {
    const result = await scanWorkspace()
    const symbol = symbolById(result, `ts:src/handler.ts#${qname}`)
    const saves = symbol.calls.filter((c) => c.target === "save")

    expect(saves.map((c) => [c.target, c.resolved])).toEqual([["save", null]])
    expect(symbol.effects).toEqual([])
  })

  it("still links a call that names the import, and carries its write", async () => {
    const result = await scanWorkspace()
    const direct = symbolById(result, "ts:src/handler.ts#direct")

    expect(direct.calls.map((c) => [c.target, c.resolved])).toEqual([
      ["save", "ts:src/repo.ts#save"],
    ])
    expect(direct.effects.map((e) => e.id)).toEqual(["db.write"])
  })
})

describe("scan — a destructuring parameter with text the parser could not place", () => {
  beforeEach(async () => {
    await workspace.writeSource("src/repo.ts", REPO)
    await workspace.writeSource(
      "src/broken.ts",
      [
        'import { save } from "./repo"',
        "",
        "export async function stray({ save, ? }: any) { await save(1) }",
        "export async function dangling({ save = }: any) { await save(2) }",
        "export async function unseparated({ save b }: any) { await save(3) }",
        "export async function arraySpread([...]: any) { await save(4) }",
        "export async function objectSpread({ ... }: any) { await save(5) }",
        "export async function strayFirst({ a, ?, save }: any) { await save(6) }",
        "export async function arrayStray([a, ?, save]: any) { await save(7) }",
        "export async function arrayStrayLast([save, ?]: any) { await save(8) }",
        "export async function arrayUnseparated([a, save b]: any) { await save(9) }",
        "export async function placed({ a: obj.b, save }: any) { await save(10) }",
        "export async function placedOnly({ save: obj.b }: any) { await save(11) }",
        "",
      ].join("\n"),
    )
  })

  it("keeps the file, and the document still validates", async () => {
    const result = await scanWorkspace()

    expect(result.skipped).toEqual([])
    expect(irSchemaViolations(result.ir)).toEqual([])
  })

  it.each([
    ["stray", "{ save, ? }", ["save"], null],
    ["dangling", "{ save = }", ["save"], null],
    ["unseparated", "{ save b }", ["save"], null],
    ["arraySpread", "[...]", undefined, "ts:src/repo.ts#save"],
    ["objectSpread", "{ ... }", undefined, "ts:src/repo.ts#save"],
    ["strayFirst", "{ a, ?, save }", ["a", "save"], null],
    ["arrayStray", "[a, ?, save]", ["a", "save"], null],
    ["arrayStrayLast", "[save, ?]", ["save"], null],
    ["arrayUnseparated", "[a, save b]", ["a", "save"], null],
    ["placed", "{ a: obj.b, save }", ["save"], null],
    ["placedOnly", "{ save: obj.b }", undefined, "ts:src/repo.ts#save"],
  ])("%s binds only what the source placed", async (qname, name, bindings, resolved) => {
    const result = await scanWorkspace()
    const symbol = symbolById(result, `ts:src/broken.ts#${qname}`)

    expect(symbol.signature?.inputs).toStrictEqual([
      bindings === undefined ? { name, type: "any" } : { name, type: "any", bindings },
    ])
    expect(symbol.calls.map((c) => [c.target, c.resolved])).toEqual([["save", resolved]])
  })
})

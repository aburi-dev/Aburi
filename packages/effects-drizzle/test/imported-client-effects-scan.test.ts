import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { drizzleEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("drizzle-imported-client")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [drizzleEffectsPlugin] })

const DB = [
  'import { drizzle } from "drizzle-orm/node-postgres"',
  "",
  'export const db = drizzle(process.env.DATABASE_URL ?? "")',
  "export type Db = typeof db",
]

const SCHEMA = [
  'import { pgTable, text } from "drizzle-orm/pg-core"',
  "",
  'export const users = pgTable("users", { id: text("id"), name: text("name") })',
]

const USERS_REPO = [
  'import { eq } from "drizzle-orm"',
  'import { type Db, db } from "./db"',
  'import { users } from "./schema"',
  "",
  "export class UsersRepo {",
  "  constructor(private readonly client: Db = db) {}",
  "",
  "  update(id: string, name: string) {",
  "    return this.client.update(users).set({ name }).where(eq(users.id, id))",
  "  }",
  "}",
]

describe("scan — a Drizzle client another module of the workspace builds", () => {
  it("classifies a call on the client the file imports", async () => {
    await workspace.writeSources({
      "src/db.ts": DB,
      "src/schema.ts": SCHEMA,
      "src/sign-up.ts": [
        'import { db } from "./db"',
        'import { users } from "./schema"',
        "",
        "export async function signUp(id: string, name: string) {",
        "  await db.insert(users).values({ id, name })",
        "}",
      ],
    })
    const signUp = symbolById(await scanWorkspace(), "ts:src/sign-up.ts#signUp")
    expect(signUp.effects.map((effect) => [effect.id, effect.target, effect.confidence])).toEqual([
      ["db.write", "db.insert", "high"],
    ])
  })

  it("classifies a call on a client a workspace type alias declares", async () => {
    await workspace.writeSources({
      "src/db.ts": DB,
      "src/schema.ts": SCHEMA,
      "src/users.repo.ts": USERS_REPO,
    })
    const update = symbolById(await scanWorkspace(), "ts:src/users.repo.ts#UsersRepo.update")
    expect(update.effects.map((effect) => [effect.id, effect.target])).toEqual([
      ["db.write", "this.client.update"],
    ])
  })

  it("resolves a call of a repository's own method, whose write reaches the caller", async () => {
    await workspace.writeSources({
      "src/db.ts": DB,
      "src/schema.ts": SCHEMA,
      "src/users.repo.ts": USERS_REPO,
      "src/users.handler.ts": [
        'import { eq } from "drizzle-orm"',
        'import { UsersRepo } from "./users.repo"',
        "",
        "export class UsersHandler {",
        "  constructor(private readonly repo: UsersRepo) {}",
        "",
        "  rename(id: string) {",
        '    return this.repo.update(id, "renamed")',
        "  }",
        "}",
      ],
    })
    const rename = symbolById(await scanWorkspace(), "ts:src/users.handler.ts#UsersHandler.rename")
    expect(rename.calls.map((call) => [call.target, call.resolved])).toEqual([
      ["this.repo.update", "ts:src/users.repo.ts#UsersRepo.update"],
    ])
    expect(rename.effects.map((effect) => [effect.id, effect.propagated === true])).toEqual([
      ["db.write", true],
    ])
  })

  it("leaves a call on an instance whose module imports Drizzle in the calls, on a name no client word places", async () => {
    await workspace.writeSources({
      "src/db.ts": DB,
      "src/schema.ts": SCHEMA,
      "src/users.repo.ts": [
        'import { eq } from "drizzle-orm"',
        'import { db } from "./db"',
        'import { users } from "./schema"',
        "",
        "class UsersRepo {",
        "  update(id: string, dto: object) {",
        "    return db.update(users).set(dto).where(eq(users.id, id))",
        "  }",
        "}",
        "",
        "export const usersRepo = new UsersRepo()",
      ],
      "src/users.controller.ts": [
        'import { usersRepo } from "./users.repo"',
        "",
        "export function save(id: string, dto: object) {",
        "  return usersRepo.update(id, dto)",
        "}",
      ],
    })
    const save = symbolById(await scanWorkspace(), "ts:src/users.controller.ts#save")
    expect(save.calls.map((call) => call.target)).toEqual(["usersRepo.update"])
    expect(save.effects.filter((effect) => effect.propagated !== true)).toEqual([])
  })

  it.each([
    [
      "a client its name places",
      "this.db.update(users).set({ name })",
      [["db.write", "this.db.update"]],
    ],
    ["no receiver a client word places", "this.cache.update(users)", []],
  ])(
    "where only a module the file imports a table from uses Drizzle, classifies %s",
    async (_case, call, expected) => {
      await workspace.writeSources({
        "src/schema.ts": SCHEMA,
        "src/accounts.ts": [
          'import { users } from "./schema"',
          "",
          "export class Accounts {",
          "  constructor(private readonly db, private readonly cache) {}",
          "",
          "  rename(name: string) {",
          `    return ${call}`,
          "  }",
          "}",
        ],
      })
      const rename = symbolById(await scanWorkspace(), "ts:src/accounts.ts#Accounts.rename")
      expect(rename.effects.map((effect) => [effect.id, effect.target])).toEqual(expected)
    },
  )
})

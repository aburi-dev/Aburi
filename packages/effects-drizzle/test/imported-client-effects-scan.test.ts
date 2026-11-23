import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { drizzleEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("drizzle-imported-client")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [drizzleEffectsPlugin] })

async function writeSources(sources: Readonly<Record<string, readonly string[]>>): Promise<void> {
  for (const [path, lines] of Object.entries(sources)) {
    await workspace.writeSource(path, [...lines, ""].join("\n"))
  }
}

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
    await writeSources({
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
    await writeSources({
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
    await writeSources({
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
})

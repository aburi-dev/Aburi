import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import type { Config } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("imported-client-effects")

const scanWorkspace = (config: Config = {}) =>
  scanWith(
    workspace.root,
    { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] },
    config,
  )

const effectsOf = async (id: string, config?: Config) =>
  symbolById(await scanWorkspace(config), id).effects.map(
    (effect) => `${effect.id} ${effect.target} ${effect.confidence}`,
  )

const LIB_DB = [
  'import { PrismaClient } from "@prisma/client"',
  "",
  "export const prisma = new PrismaClient()",
]

const PRISMA_SERVICE = [
  'import { Injectable, OnModuleInit } from "@nestjs/common"',
  'import { PrismaClient } from "@prisma/client"',
  "",
  "@Injectable()",
  "export class PrismaService extends PrismaClient implements OnModuleInit {",
  "  async onModuleInit() {",
  "    await this.$connect()",
  "  }",
  "}",
]

describe("scan — a Prisma client another module of the workspace builds", () => {
  it.each<[string, Readonly<Record<string, readonly string[]>>, string, string[]]>([
    [
      "imported from the module that builds it",
      {
        "src/lib/db.ts": LIB_DB,
        "src/users.ts": [
          'import { prisma } from "./lib/db"',
          "",
          "export async function listUsers() {",
          "  return prisma.user.findMany()",
          "}",
        ],
      },
      "ts:src/users.ts#listUsers",
      ["db.read prisma.user.findMany high"],
    ],
    [
      "imported through a barrel's `export *`",
      {
        "src/lib/db.ts": LIB_DB,
        "src/lib/index.ts": ['export * from "./db"'],
        "src/users.ts": [
          'import { prisma as db } from "./lib"',
          "",
          "export async function removeUser(id: string) {",
          "  return db.user.delete({ where: { id } })",
          "}",
        ],
      },
      "ts:src/users.ts#removeUser",
      ["db.write db.user.delete high"],
    ],
    [
      "injected as a NestJS service that extends PrismaClient",
      {
        "src/prisma.service.ts": PRISMA_SERVICE,
        "src/posts.service.ts": [
          'import { Injectable } from "@nestjs/common"',
          'import { PrismaService } from "./prisma.service"',
          "",
          "@Injectable()",
          "export class PostsService {",
          "  constructor(private readonly prisma: PrismaService) {}",
          "",
          "  remove(id: string) {",
          "    return this.prisma.post.delete({ where: { id } })",
          "  }",
          "}",
        ],
      },
      "ts:src/posts.service.ts#PostsService.remove",
      ["db.write this.prisma.post.delete high"],
    ],
    [
      "an inherited transaction on the injected service",
      {
        "src/prisma.service.ts": PRISMA_SERVICE,
        "src/orders.service.ts": [
          'import { PrismaService } from "./prisma.service"',
          "",
          "export class OrdersService {",
          "  constructor(private readonly orm: PrismaService) {}",
          "",
          "  settle() {",
          "    return this.orm.$transaction([])",
          "  }",
          "}",
        ],
      },
      "ts:src/orders.service.ts#OrdersService.settle",
      ["db.transaction this.orm.$transaction high"],
    ],
    [
      "generated to `generated/prisma`, as Prisma 7 writes it",
      {
        "src/lib/prisma.ts": [
          'import { PrismaClient } from "../generated/prisma/client"',
          "",
          "const prisma = new PrismaClient()",
          "",
          "export async function createUser(email: string) {",
          "  return prisma.user.create({ data: { email } })",
          "}",
        ],
      },
      "ts:src/lib/prisma.ts#createUser",
      ["db.write prisma.user.create high"],
    ],
  ])("classifies a call on one %s", async (_case, sources, id, expected) => {
    await workspace.writeSources(sources)
    expect(await effectsOf(id)).toEqual(expected)
  })

  it("leaves a receiver no name places alone where only an imported module leads to Prisma", async () => {
    await workspace.writeSources({
      "src/prisma.service.ts": PRISMA_SERVICE,
      "src/cache.service.ts": [
        'import { PrismaService } from "./prisma.service"',
        "",
        "export class CacheService {",
        "  constructor(private readonly prisma: PrismaService, private readonly store: Map<string, unknown>) {}",
        "",
        "  evict(key: string) {",
        "    return this.store.entries.delete({ key })",
        "  }",
        "}",
      ],
    })
    expect(await effectsOf("ts:src/cache.service.ts#CacheService.evict")).toEqual([])
  })

  it("leaves a name an `export *` target beside the client's exports alone", async () => {
    await workspace.writeSources({
      "src/lib/db.ts": LIB_DB,
      "src/lib/cache.ts": ["export const cache = new Map<string, unknown>()"],
      "src/lib/index.ts": ['export * from "./db"', 'export * from "./cache"'],
      "src/cache.ts": [
        'import { cache } from "./lib"',
        "",
        "export function evict(key: string) {",
        "  return cache.entries.delete({ key })",
        "}",
      ],
    })
    expect(await effectsOf("ts:src/cache.ts#evict")).toEqual([])
  })

  it.each([
    ["a client its name places", "prisma", "./db", ["db.write prisma.user.create high"]],
    ["a client imported under a name that places none", "prisma as store", "./db", []],
    ["a name a module without Prisma declares", "cache", "./cache", []],
  ])(
    "gives %s the same effects whether or not the file also imports a Prisma type",
    async (_case, binding, module, expected) => {
      const local = binding.split(" as ").at(-1)
      const consumer = (typeImport: readonly string[]) => [
        ...typeImport,
        `import { ${binding} } from "${module}"`,
        "",
        "export async function createUser(email: string) {",
        `  return ${local}.user.create({ data: { email } })`,
        "}",
      ]
      await workspace.writeSources({
        "src/db.ts": LIB_DB,
        "src/cache.ts": ["export const cache = new Map<string, unknown>()"],
        "src/users.ts": consumer([]),
      })
      const without = await effectsOf("ts:src/users.ts#createUser")
      await workspace.writeSources({
        "src/users.ts": consumer(['import type { User } from "@prisma/client"']),
      })
      expect(await effectsOf("ts:src/users.ts#createUser")).toEqual(without)
      expect(without).toEqual(expected)
    },
  )
})

describe("scan — a client generated where the plugin's options say", () => {
  const sources = {
    "src/db/client.ts": ['export { PrismaClient } from "./runtime"'],
    "src/users.ts": [
      'import { PrismaClient } from "./db/client"',
      "",
      "const prisma = new PrismaClient()",
      "",
      "export async function listUsers() {",
      "  return prisma.user.findMany()",
      "}",
    ],
  }

  it("classifies the client's calls once `clientModules` names its module", async () => {
    await workspace.writeSources(sources)
    const config: Config = { pluginOptions: { "effects-prisma": { clientModules: ["db/client"] } } }
    expect(await effectsOf("ts:src/users.ts#listUsers", config)).toEqual([
      "db.read prisma.user.findMany high",
    ])
  })

  it("leaves them alone without it", async () => {
    await workspace.writeSources(sources)
    expect(await effectsOf("ts:src/users.ts#listUsers")).toEqual([])
  })
})

describe("scan — a call of a service's own method, in a file that imports a Prisma type", () => {
  const SERVICE_BODY = [
    "  constructor(private readonly prisma: PrismaService) {}",
    "",
    "  create(data: Prisma.UserCreateInput) {",
    "    return this.prisma.user.create({ data })",
    "  }",
    "}",
  ]

  it.each([
    [
      "by its name",
      ["export class UsersService {", ...SERVICE_BODY],
      'import { UsersService } from "./users.service"',
      "UsersService.create",
    ],
    [
      "as its default",
      ["export default class UsersService {", ...SERVICE_BODY],
      'import UsersService from "./users.service"',
      "UsersService.create",
    ],
    [
      "under the name an export clause gives it",
      ["class Service {", ...SERVICE_BODY, "", "export { Service as UsersService }"],
      'import { UsersService } from "./users.service"',
      "Service.create",
    ],
  ])(
    "resolves the call to the method of a class the service module exports %s, whose write reaches the caller",
    async (_case, service, serviceImport, method) => {
      await workspace.writeSources({
        "src/prisma.service.ts": PRISMA_SERVICE,
        "src/users.service.ts": [
          'import type { Prisma } from "@prisma/client"',
          'import { PrismaService } from "./prisma.service"',
          "",
          ...service,
        ],
        "src/users.controller.ts": [
          'import type { Prisma } from "@prisma/client"',
          serviceImport,
          "",
          "export class UsersController {",
          "  constructor(private readonly usersService: UsersService) {}",
          "",
          "  create(dto: Prisma.UserCreateInput) {",
          "    return this.usersService.create(dto)",
          "  }",
          "}",
        ],
      })
      const result = await scanWorkspace()
      const create = symbolById(result, "ts:src/users.controller.ts#UsersController.create")

      expect(create.calls.map((call) => [call.target, call.resolved])).toEqual([
        ["this.usersService.create", `ts:src/users.service.ts#${method}`],
      ])
      expect(create.effects.map((effect) => [effect.id, effect.propagated === true])).toEqual([
        ["db.write", true],
      ])
    },
  )
})

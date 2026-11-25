import { importEdge } from "@aburi/test-support"
import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { hasPrismaImport, prismaClientModuleMatcher } from "../src/index"

const PATH = "src/service.ts"

function edge(source: string, line = 1): ImportEdge {
  return importEdge({ source, symbols: ["PrismaClient"], line })
}

describe("hasPrismaImport", () => {
  it.each([
    ["@prisma/client", [edge("@prisma/client")]],
    ["the Edge runtime entry @prisma/client/edge", [edge("@prisma/client/edge")]],
    ["@prisma/client beside other imports", [edge("react", 1), edge("@prisma/client", 2)]],
  ])("returns true when the file imports %s", (_label, imports) => {
    expect(hasPrismaImport(imports, PATH)).toBe(true)
  })

  it.each([
    ["nothing", []],
    ["unrelated ORMs", [edge("drizzle-orm", 1), edge("typeorm", 2)]],
    ["lookalike specifiers", [edge("@prisma/client-edge", 1), edge("@my-org/prisma-client", 2)]],
  ])("returns false when the file imports %s", (_label, imports) => {
    expect(hasPrismaImport(imports, PATH)).toBe(false)
  })

  it("throws on an empty ImportEdge.source, naming the plugin, the file, and the line", () => {
    expect(() => hasPrismaImport([edge("", 9)], PATH)).toThrow(
      `effects-prisma (${PATH}, line 9): ImportEdge.source is empty`,
    )
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    expect(() => hasPrismaImport([edge("@prisma/client", 1), edge("", 2)], PATH)).toThrow(
      /ImportEdge\.source is empty/,
    )
  })
})

describe("prismaClientModuleMatcher", () => {
  const matches = prismaClientModuleMatcher(["db/client", "@acme/orm"])

  it.each([
    ["a subpath of @prisma/client", "@prisma/client/runtime/library"],
    ["a driver adapter", "@prisma/adapter-pg"],
    ["a client extension", "@prisma/extension-accelerate"],
    ["the generated client's directory", "../generated/prisma"],
    ["the generated client's entry", "../../generated/prisma/client"],
    ["the generated client's edge entry, with its extension", "./generated/prisma/edge.js"],
    ["the generated client's browser entry", "@/generated/prisma/browser"],
    ["the generated client's index file", "../generated/prisma/index.ts"],
    ["a module the options name, by its last segments", "../../db/client"],
    ["a module the options name, as an alias spells it", "@/db/client.ts"],
    ["a package the options name", "@acme/orm"],
  ])("takes %s", (_label, source) => {
    expect(matches(source)).toBe(true)
  })

  it.each([
    ["a bare adapter prefix", "@prisma/adapter-"],
    ["another @prisma package", "@prisma/config"],
    ["a directory under the generated client", "../generated/prisma/models/User"],
    ["a generated directory of another generator", "../generated/zod"],
    ["a module whose last segments differ from an option's", "../db/client/extra"],
    ["a module ending in only part of an option", "../client"],
  ])("refuses %s", (_label, source) => {
    expect(matches(source)).toBe(false)
  })
})

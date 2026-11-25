import { noopRegistry, silentLogger } from "@aburi/test-support"
import type { Config } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { PrismaOptionsError, prismaEffectsPlugin, readPrismaOptions } from "../src/index"

const withOptions = (options: unknown): Config => ({ pluginOptions: { "effects-prisma": options } })

describe("readPrismaOptions", () => {
  it.each<[string, Config, object]>([
    ["no options", {}, {}],
    ["an empty object", withOptions({}), {}],
    [
      "a list of client modules",
      withOptions({ clientModules: ["db/client"] }),
      { clientModules: ["db/client"] },
    ],
    [
      "a client module written with spaces around it, as matching reads it",
      withOptions({ clientModules: [" db/client "] }),
      { clientModules: ["db/client"] },
    ],
  ])("reads %s", (_label, config, expected) => {
    expect(readPrismaOptions(config)).toEqual(expected)
  })

  it.each([
    ["a value that is no object", withOptions(["db/client"]), /must be an object/],
    ["an unknown key", withOptions({ clientModule: "db/client" }), /unknown key "clientModule"/],
    [
      "client modules that are no list",
      withOptions({ clientModules: "db/client" }),
      /clientModules/,
    ],
    ["an empty client module", withOptions({ clientModules: ["  "] }), /clientModules/],
    ...[".", "./", "index", "./index.ts"].map((entry): [string, Config, RegExp] => [
      `a client module with no path segment to match, ${JSON.stringify(entry)}`,
      withOptions({ clientModules: [entry] }),
      /clientModules/,
    ]),
  ])("refuses %s, naming the option", (_label, config, message) => {
    expect(() => readPrismaOptions(config)).toThrow(PrismaOptionsError)
    expect(() => readPrismaOptions(config)).toThrow(message)
  })

  it("throws from init, naming the option", async () => {
    const ctx = {
      registry: noopRegistry,
      config: withOptions({ clientModules: [1] }),
      workspaceRoot: "/tmp",
      log: silentLogger,
    }
    await expect(prismaEffectsPlugin.init(ctx)).rejects.toThrow(
      'pluginOptions["effects-prisma"].clientModules must be a list of module specifiers, each naming a module by its path',
    )
  })
})

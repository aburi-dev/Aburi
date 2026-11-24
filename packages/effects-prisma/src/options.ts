import type { Config } from "@aburi/types"
import { EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"
import {
  moduleSegments,
  type PrismaClientModuleMatcher,
  prismaClientModuleMatcher,
} from "./imports"

/** `pluginOptions["effects-prisma"]`. */
export interface PrismaPluginOptions {
  /**
   * Modules a generated client is imported from besides the ones the plugin knows, for a
   * generator `output` that is not `generated/prisma`: a module matches when an import's last
   * path segments are the entry's, so `"db/client"` matches `"../db/client"` and `"@/db/client"`.
   */
  readonly clientModules?: readonly string[]
}

export class PrismaOptionsError extends Error {
  constructor(message: string) {
    super(`pluginOptions["${EFFECTS_PRISMA_PLUGIN_NAME}"]${message}`)
    this.name = "PrismaOptionsError"
  }
}

export function readPrismaOptions(config: Config): PrismaPluginOptions {
  const written: unknown = config.pluginOptions?.[EFFECTS_PRISMA_PLUGIN_NAME]
  if (written === undefined) return {}
  if (typeof written !== "object" || written === null || Array.isArray(written)) {
    throw new PrismaOptionsError(" must be an object")
  }
  for (const key of Object.keys(written)) {
    if (key !== "clientModules") {
      throw new PrismaOptionsError(` has an unknown key "${key}"; the one key is "clientModules"`)
    }
  }
  const clientModules: unknown = Reflect.get(written, "clientModules")
  if (clientModules === undefined) return {}
  // An entry with no path segment to match, such as `"./"` or `"index"`, would match no import.
  if (
    !Array.isArray(clientModules) ||
    !clientModules.every(
      (entry): entry is string =>
        typeof entry === "string" && moduleSegments(entry.trim()).length > 0,
    )
  ) {
    throw new PrismaOptionsError(
      ".clientModules must be a list of module specifiers, each naming a module by its path",
    )
  }
  return { clientModules: clientModules.map((entry) => entry.trim()) }
}

const matchers = new WeakMap<Config, PrismaClientModuleMatcher>()

/** The matcher a config's options give, built once per config the scan hands the plugin. */
export function clientModuleMatcherFor(config: Config): PrismaClientModuleMatcher {
  let matcher = matchers.get(config)
  if (matcher === undefined) {
    matcher = prismaClientModuleMatcher(readPrismaOptions(config).clientModules)
    matchers.set(config, matcher)
  }
  return matcher
}

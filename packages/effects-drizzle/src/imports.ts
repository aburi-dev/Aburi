import { hasMatchingImport, matchesModuleOrSubpath } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_DRIZZLE_PLUGIN_NAME } from "./constants"

export const DRIZZLE_MODULES_LIST = ["drizzle-orm"] as const

export const isDrizzleModule: (source: string) => boolean = matchesModuleOrSubpath(
  ...DRIZZLE_MODULES_LIST,
)

export function hasDrizzleImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_DRIZZLE_PLUGIN_NAME, filePath },
    isDrizzleModule,
  )
}

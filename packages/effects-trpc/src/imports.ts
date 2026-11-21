import { hasMatchingImport, matchesModuleOrSubpath } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_TRPC_PLUGIN_NAME } from "./constants"

const isTrpcClientModule = matchesModuleOrSubpath("@trpc/client", "@trpc/react-query", "@trpc/next")

export function hasTrpcClientImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_TRPC_PLUGIN_NAME, filePath },
    isTrpcClientModule,
  )
}

import {
  assertNonEmptySegments,
  importGate,
  type PluginInputOrigin,
} from "@aburi/plugin-registry/plugin-input"
import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectDecline,
} from "@aburi/types"
import { EFFECTS_TRPC_DERIVED_BY_PREFIX, EFFECTS_TRPC_PLUGIN_NAME } from "./constants"
import { isTrpcClientModule } from "./imports"
import {
  isTrpcMutationTerminal,
  isTrpcQueryTerminal,
  isTrpcSubscriptionTerminal,
  TRPC_OPTIONS_TERMINALS,
  type TrpcQueryTerminal,
} from "./methods"

const PROCEDURE_BUILDER_TERMINAL: TrpcQueryTerminal = "query"

// tRPC's documentation and create-t3-app name a base procedure `procedure` or `…Procedure`.
const PROCEDURE_NAME = /(^p|P)rocedure$/

const MIN_CLIENT_SEGMENTS = 3

export function classifyTrpcCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | EffectDecline | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_TRPC_PLUGIN_NAME, filePath: ctx.file.path }

  const { segments, last: terminal } = assertNonEmptySegments(call.target, origin)

  // A tRPC client has no name of its own to place it by, so what only a module the file imports
  // another name from reaches is not enough: the client must be the file's import, or bound by one
  // that leads to the client's module, as `import { api } from "~/trpc/react"` does.
  const gate = importGate(ctx.file.imports, segments[0], origin, isTrpcClientModule)
  if (gate !== "direct" && gate !== "bound") return null

  const clientPath = segments[0] === "this" ? segments.slice(1) : segments
  if (clientPath.length < MIN_CLIENT_SEGMENTS) return null

  // The router's own builder (`publicProcedure.input(schema).query(resolver)`) is spelled alike.
  if (terminal === PROCEDURE_BUILDER_TERMINAL && buildsOnProcedure(clientPath)) {
    return { declined: `${EFFECTS_TRPC_DERIVED_BY_PREFIX}:procedure-query` }
  }

  const family = terminalFamily(terminal)
  if (family === null) return null

  const procedurePath = clientPath.slice(1, -1).join(".")

  return {
    effectId: "network.rpc",
    // Options can be built and never handed to anything that sends them.
    confidence:
      call.dynamicReceiver === true || TRPC_OPTIONS_TERMINALS.has(terminal) ? "medium" : "high",
    derivedBy: `${EFFECTS_TRPC_DERIVED_BY_PREFIX}:${family}:${procedurePath}`,
  }
}

// `t.procedure` is read off the instance, so a `procedure` deeper down is a router key.
function buildsOnProcedure([root, next]: readonly string[]): boolean {
  return (root !== undefined && PROCEDURE_NAME.test(root)) || next === "procedure"
}

function terminalFamily(terminal: string): "query" | "mutation" | "subscription" | null {
  if (isTrpcQueryTerminal(terminal)) return "query"
  if (isTrpcMutationTerminal(terminal)) return "mutation"
  if (isTrpcSubscriptionTerminal(terminal)) return "subscription"
  return null
}

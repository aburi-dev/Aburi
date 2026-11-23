import {
  assertNonEmptySegments,
  hasLiteralFirstArgument,
  importGate,
  type PluginInputOrigin,
  receiverTypeFromMatchingModule,
  typedReceiverConfidence,
} from "@aburi/plugin-registry/plugin-input"
import {
  type CallCandidate,
  type ClassifyContext,
  COMPUTED_TARGET_SEGMENT,
  type EffectClassification,
  type EffectDecline,
} from "@aburi/types"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"
import {
  isPrismaRawQueryMethod,
  isPrismaReadMethod,
  isPrismaTransactionMethod,
  isPrismaWriteMethod,
} from "./methods"
import { clientModuleMatcherFor } from "./options"
import {
  classificationConfidence,
  isClientBindingWord,
  namesPrismaClient,
  PRISMA_DELEGATE_MAX_ARGUMENTS,
  PRISMA_TRANSACTION_MAX_ARGUMENTS,
} from "./receivers"

export function classifyPrismaCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | EffectDecline | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_PRISMA_PLUGIN_NAME, filePath: ctx.file.path }

  const { segments, last: method } = assertNonEmptySegments(call.target, origin)

  const matches = clientModuleMatcherFor(ctx.config)
  const gate = importGate(ctx.file.imports, segments[0], origin, matches)
  if (gate === null) return null
  // What only reaches the file through a module it imports from is a weaker sign than its own
  // import, so there the client must be one its name places.
  const placed = (clientSegment: string | undefined): boolean =>
    gate === "direct" || (clientSegment !== undefined && namesPrismaClient(clientSegment))

  if (isPrismaTransactionMethod(method)) {
    // A bare `$transaction()` is not a Prisma call; the API is a method on the client.
    if (segments.length < 2) return null
    if (hasLiteralFirstArgument(call)) return null
    if (!placed(segments.at(-2))) return null
    return {
      effectId: "db.transaction",
      confidence: classificationConfidence(segments.at(-2), call, PRISMA_TRANSACTION_MAX_ARGUMENTS),
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:tx`,
    }
  }

  // Whether a raw query reads or writes is in the query, which no call site spells.
  if (isPrismaRawQueryMethod(method) && segments.length >= 2) {
    if (!placed(segments.at(-2))) return null
    return { declined: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:raw-query` }
  }

  // `<client>.<model>.<verb>`: two-segment calls are `router.create(...)` and friends.
  if (segments.length < 3) return null

  // A delegate takes an options object or nothing, so `map.delete("id")` is another API.
  if (hasLiteralFirstArgument(call)) return null

  const modelSegment = segments.at(-2)
  // The client sits immediately before the model, whatever precedes it.
  const clientSegment = segments.at(-3)

  // A model is named after a table, so `this.db.delete(table)` is another ORM's `<client>.<verb>`,
  // unless a client stands in front of it: `prisma.tx.create` writes to a `Tx` model.
  if (
    modelSegment !== undefined &&
    isClientBindingWord(modelSegment) &&
    !(clientSegment !== undefined && namesPrismaClient(clientSegment))
  ) {
    return null
  }

  // A computed model says nothing about the shape, so the receiver alone must name a client.
  if (clientSegment !== undefined && modelSegment === COMPUTED_TARGET_SEGMENT) {
    if (!namesPrismaClient(clientSegment)) return null
  }

  if (!placed(clientSegment)) return null

  const confidence = receiverTypeFromMatchingModule(
    ctx.file.imports,
    call.receiverType,
    origin,
    matches,
  )
    ? typedReceiverConfidence(call, PRISMA_DELEGATE_MAX_ARGUMENTS)
    : classificationConfidence(clientSegment, call, PRISMA_DELEGATE_MAX_ARGUMENTS)

  if (isPrismaReadMethod(method)) {
    return {
      effectId: "db.read",
      confidence,
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:read`,
    }
  }

  if (isPrismaWriteMethod(method)) {
    return {
      effectId: "db.write",
      confidence,
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:write`,
    }
  }

  return null
}

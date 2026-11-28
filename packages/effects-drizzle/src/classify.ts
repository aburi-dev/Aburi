import {
  assertNonEmptySegments,
  hasLiteralFirstArgument,
  importGate,
  type PluginInputOrigin,
  receiverTypeFromMatchingModule,
  typedReceiverConfidence,
} from "@aburi/plugin-registry/plugin-input"
import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectDecline,
} from "@aburi/types"
import { EFFECTS_DRIZZLE_DERIVED_BY_PREFIX, EFFECTS_DRIZZLE_PLUGIN_NAME } from "./constants"
import { isDrizzleModule } from "./imports"
import {
  DRIZZLE_CTE_METHODS,
  DRIZZLE_FLUENT_ROOT_METHODS,
  isDrizzleQueryMethod,
  isDrizzleRawSqlMethod,
  isDrizzleReadMethod,
  isDrizzleTransactionMethod,
  isDrizzleWriteMethod,
  maxArgumentsFor,
  minArgumentsFor,
} from "./methods"
import { classificationConfidence, namesDrizzleClient, namesOrmClient } from "./receivers"

export function classifyDrizzleCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | EffectDecline | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_DRIZZLE_PLUGIN_NAME, filePath: ctx.file.path }

  const { segments, last: method } = assertNonEmptySegments(call.target, origin)

  const gate = importGate(ctx.file.imports, segments[0], origin, isDrizzleModule)
  if (gate === null) return null

  // A bare `select()` has no client receiver and is not Drizzle.
  if (segments.length < 2) return null

  // Chain-collapse: a fluent-root verb in an internal segment marks a downstream link.
  const fluentRoots = DRIZZLE_FLUENT_ROOT_METHODS as ReadonlySet<string>
  for (const segment of segments.slice(1, -1)) {
    if (fluentRoots.has(segment)) return null
  }

  // Every Drizzle write and transaction takes an argument, so a bare call is another API's.
  if (call.argumentCount < minArgumentsFor(method)) return null

  // A receiver declared with the library's own type is its client whatever it is called.
  const typed = receiverTypeFromMatchingModule(
    ctx.file.imports,
    call.receiverType,
    origin,
    isDrizzleModule,
  )
  // A module the file imports from using Drizzle is a weaker sign than the file's own import, so
  // there the client must be one its type or its name places.
  const placed = (clientSegment: string | undefined): boolean =>
    gate === "direct" || typed || (clientSegment !== undefined && namesDrizzleClient(clientSegment))

  if (segments.length >= 4 && segments.at(-3) === "query" && isDrizzleQueryMethod(method)) {
    if (hasLiteralFirstArgument(call)) return null
    if (!placed(segments.at(-4))) return null
    return {
      effectId: "db.read",
      confidence: classificationConfidence(segments.at(-4), call, maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:read`,
    }
  }

  // Every remaining shape is a call directly on the client, so the client is at -2, or at -3
  // behind the CTE a root verb is built on.
  const behindCte = fluentRoots.has(method) && DRIZZLE_CTE_METHODS.has(segments.at(-2) ?? "")
  const clientIndex = behindCte ? -3 : -2
  const clientSegment = segments.at(clientIndex)
  if (!placed(clientSegment)) return null

  // `prisma.user.delete` and `tx.user.update` are another ORM's `<client>.<model>.<verb>`. Plugins
  // are asked in config order and the first claim wins, so a `medium` claim here would hide its `high`.
  const inFront = segments.at(clientIndex - 1)
  if (
    !typed &&
    clientSegment !== undefined &&
    !namesDrizzleClient(clientSegment) &&
    inFront !== undefined &&
    namesOrmClient(inFront)
  ) {
    return null
  }

  // `db.with(sq).select()` is read off the CTE's own call, which is no less the client's.
  const tiered =
    behindCte && call.receiverCall?.target === segments.slice(0, -1).join(".")
      ? { ...call, dynamicReceiver: false }
      : call
  const confidence = (maxArguments: number) =>
    typed
      ? typedReceiverConfidence(tiered, maxArguments)
      : classificationConfidence(clientSegment, tiered, maxArguments)

  if (isDrizzleReadMethod(method)) {
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.read",
      confidence: confidence(maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:read`,
    }
  }

  if (isDrizzleWriteMethod(method)) {
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.write",
      confidence: confidence(maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:write`,
    }
  }

  if (isDrizzleTransactionMethod(method)) {
    // A transaction takes a callback or a statement array, never a literal.
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.transaction",
      confidence: confidence(maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:tx`,
    }
  }

  // Whether raw SQL reads or writes is in the SQL, which no call site spells.
  if (
    isDrizzleRawSqlMethod(method) &&
    call.argumentCount > 0 &&
    clientSegment !== undefined &&
    namesDrizzleClient(clientSegment)
  ) {
    return { declined: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:raw-sql` }
  }

  return null
}

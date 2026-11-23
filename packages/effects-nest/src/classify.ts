import { assertNonEmptySegments, type PluginInputOrigin } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, ClassifyContext, EffectClassification, ImportEdge } from "@aburi/types"
import { EFFECTS_NEST_DERIVED_BY_PREFIX, EFFECTS_NEST_PLUGIN_NAME } from "./constants"
import {
  hasNestCqrsImport,
  hasNestEmitterImport,
  isNestEmitMethod,
  isNestEventEmitterIdentifier,
  isNestPublishMethod,
  NEST_EMITTER_CLASS,
  NEST_EVENT_BUS_CLASS,
  NEST_EVENT_BUS_IDENTIFIER,
  namesNestEmitterClass,
  namesNestEventBusClass,
} from "./emitters"

/** A library a provider publishes events through: the names and the class that reach it. */
interface EventChannel {
  readonly namesReceiver: (name: string) => boolean
  readonly className: string
  readonly namesClass: (imports: readonly ImportEdge[], type: string, filePath: string) => boolean
}

const EMITTER: EventChannel = {
  namesReceiver: isNestEventEmitterIdentifier,
  className: NEST_EMITTER_CLASS,
  namesClass: namesNestEmitterClass,
}

const EVENT_BUS: EventChannel = {
  namesReceiver: (name) => name === NEST_EVENT_BUS_IDENTIFIER,
  className: NEST_EVENT_BUS_CLASS,
  namesClass: namesNestEventBusClass,
}

export function classifyNestCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath: ctx.file.path }

  const { segments, last: method } = assertNonEmptySegments(call.target, origin)

  const { imports, path } = ctx.file
  const channel = channelFor(method, imports, path)
  if (channel === null) return null

  // The `undefined` arm is the two-segment minimum: a bare `emit()` has no receiver to read.
  const nameSegment = segments[segments.length - 2]
  if (nameSegment === undefined) return null
  if (channel.namesReceiver(nameSegment)) return publish(`${nameSegment}.${method}`)

  const { receiverType } = call
  if (receiverType === undefined) return null
  if (!channel.namesClass(imports, receiverType, path)) return null
  return publish(`${channel.className}.${method}`)
}

function channelFor(
  method: string,
  imports: readonly ImportEdge[],
  filePath: string,
): EventChannel | null {
  // Read for every call, so a malformed edge fails the file whatever the call's method.
  const emitterImported = hasNestEmitterImport(imports, filePath)
  if (isNestEmitMethod(method)) return emitterImported ? EMITTER : null
  if (isNestPublishMethod(method) && hasNestCqrsImport(imports, filePath)) return EVENT_BUS
  return null
}

function publish(evidence: string): EffectClassification {
  return {
    effectId: "event.publish",
    confidence: "high",
    derivedBy: `${EFFECTS_NEST_DERIVED_BY_PREFIX}:${evidence}`,
  }
}

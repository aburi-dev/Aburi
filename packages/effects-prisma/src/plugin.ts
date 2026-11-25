import type {
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectDecline,
  EffectPlugin,
  PluginContext,
} from "@aburi/types"
import { classifyPrismaCall } from "./classify"
import { effectsPrismaManifest } from "./manifest"
import { readPrismaOptions } from "./options"

class PrismaEffectsPlugin implements EffectPlugin {
  readonly manifest: typeof effectsPrismaManifest = effectsPrismaManifest

  async init(ctx: PluginContext): Promise<void> {
    readPrismaOptions(ctx.config)
  }

  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | EffectDecline | null {
    return classifyPrismaCall(call, ctx)
  }
}

export const prismaEffectsPlugin: PrismaEffectsPlugin = new PrismaEffectsPlugin()

export { PrismaEffectsPlugin }

import type {
  EffectPlugin,
  FrameworkPlugin,
  LanguagePlugin,
  Logger,
  PluginContext,
} from "@aburi/types"
import { CoreError } from "../errors"
import type { ExtractionJob, ExtractionPlugins } from "./extract-file"
import { describeThrown } from "./faults"

type ScanPlugin = LanguagePlugin | FrameworkPlugin | EffectPlugin

/** Cleans up, newest first, the plugins it was returned for; called again, it does nothing. */
export type PluginCleanup = () => Promise<void>

/**
 * Initializes the plugins one at a time — the languages, the frameworks, then the effects — each
 * object once. One whose `init` fails rejects, once the plugins initialized before it are cleaned up.
 */
export async function initializePlugins(
  plugins: ExtractionPlugins,
  job: Pick<ExtractionJob, "workspaceRoot" | "config">,
  log: Logger,
): Promise<PluginCleanup> {
  const ctx: PluginContext = {
    registry: plugins.registry,
    config: job.config,
    workspaceRoot: job.workspaceRoot,
    log,
  }
  const ready: ScanPlugin[] = []
  const cleanUp = async (): Promise<void> => {
    for (const plugin of ready.splice(0).reverse()) await cleanUpOne(plugin, log)
  }
  try {
    for (const plugin of new Set<ScanPlugin>([
      ...plugins.languages,
      ...plugins.frameworks,
      ...plugins.effects,
    ])) {
      await initialize(plugin, ctx)
      ready.push(plugin)
    }
  } catch (error) {
    await cleanUp()
    throw error
  }
  return cleanUp
}

async function initialize(plugin: ScanPlugin, ctx: PluginContext): Promise<void> {
  // Plugins arrive as plain JavaScript, and one written before the core called `init` may lack it.
  if (typeof plugin.init !== "function") return
  try {
    await plugin.init(ctx)
  } catch (error) {
    throw new CoreError(
      `Plugin "${plugin.manifest.name}" failed to initialize: ${describeThrown(error)}`,
      { code: "plugin-init-failed", value: plugin.manifest.name },
      { cause: error },
    )
  }
}

async function cleanUpOne(plugin: ScanPlugin, log: Logger): Promise<void> {
  if (typeof plugin.cleanup !== "function") return
  try {
    await plugin.cleanup()
  } catch (error) {
    // Every plugin call is over by now, so what the scan found stands.
    log.warn(`Plugin "${plugin.manifest.name}" failed to clean up: ${describeThrown(error)}`)
  }
}

import type {
  EffectPlugin,
  FrameworkPlugin,
  LanguagePlugin,
  Logger,
  PluginContext,
} from "@aburi/types"
import { CoreError } from "../errors"
import type { ExtractionJob, ExtractionPlugins } from "./extract-file"
import { describeJsonType, describeThrown } from "./faults"

type ScanPlugin = LanguagePlugin | FrameworkPlugin | EffectPlugin

/** Cleans up, newest first, the plugins it was returned for; called again, it does nothing. */
export type PluginCleanup = () => Promise<void>

/**
 * Initializes the plugins one at a time — the languages, the frameworks, then the effects — each
 * object once. One whose `init` fails rejects, once those initialized before it are cleaned up.
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
  const lineup = new Set<ScanPlugin>([
    ...plugins.languages,
    ...plugins.frameworks,
    ...plugins.effects,
  ])
  for (const plugin of lineup) assertLifecycleShape(plugin)
  const ready: ScanPlugin[] = []
  const cleanUp = async (): Promise<void> => {
    for (const plugin of ready.splice(0).reverse()) await cleanUpOne(plugin, log)
  }
  try {
    for (const plugin of lineup) {
      await initialize(plugin, ctx)
      ready.push(plugin)
    }
  } catch (error) {
    await cleanUp()
    throw error
  }
  return cleanUp
}

// Plugins arrive as plain JavaScript, so the types alone do not keep a value that cannot be called
// out of `init` or `cleanup`.
function assertLifecycleShape(plugin: ScanPlugin): void {
  for (const member of ["init", "cleanup"] as const) {
    const value: unknown = plugin[member]
    if (value === undefined || typeof value === "function") continue
    throw new CoreError(
      `Plugin "${plugin.manifest.name}" sets ${member} to ${describeJsonType(value)}, not a function: leave it out, or make it an async function.`,
      { code: "scan-plugin-misconfigured", value: plugin.manifest.name },
    )
  }
}

async function initialize(plugin: ScanPlugin, ctx: PluginContext): Promise<void> {
  if (plugin.init === undefined) return
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
  if (plugin.cleanup === undefined) return
  try {
    await plugin.cleanup()
  } catch (error) {
    // Every plugin call is over by now, so what the scan found stands.
    log.warn(`Plugin "${plugin.manifest.name}" failed to clean up: ${describeThrown(error)}`)
  }
}

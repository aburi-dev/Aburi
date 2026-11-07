import type { Config } from "./generated/config"
import type { DiffResult } from "./generated/diff"
import type { IR } from "./generated/ir"
import type { PluginManifest } from "./generated/plugin"

export const IR_SCHEMA_URL = "https://aburi.dev/schema/aburi.ir.v1.json" satisfies IR["$schema"]

export const DIFF_SCHEMA_URL =
  "https://aburi.dev/schema/aburi.diff.v1.json" satisfies DiffResult["$schema"]

export const CONFIG_SCHEMA_URL =
  "https://aburi.dev/schema/aburi.config.v1.json" satisfies Config["$schema"]

export const PLUGIN_SCHEMA_URL =
  "https://aburi.dev/schema/aburi.plugin.v1.json" satisfies PluginManifest["$schema"]

/** v1 was served from this host before aburi.dev, and IR documents written then still name it. */
const EARLIER_IR_SCHEMA_URL =
  "https://aburi.kage1020.com/schema/aburi.ir.v1.json" satisfies IR["$schema"]

const IR_SCHEMA_URLS: readonly IR["$schema"][] = [IR_SCHEMA_URL, EARLIER_IR_SCHEMA_URL]

export function isIRSchemaURL(value: unknown): value is IR["$schema"] {
  return IR_SCHEMA_URLS.some((url) => url === value)
}

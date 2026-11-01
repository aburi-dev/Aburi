import { CONFIG_SCHEMA_URL, type Config, type FrameworkHint } from "@aburi/types"

export function withHints(...hints: FrameworkHint[]): Config {
  return { $schema: CONFIG_SCHEMA_URL, frameworkHints: hints }
}

export function hint(name: string, partial: Partial<FrameworkHint> = {}): FrameworkHint {
  return { name, ...partial }
}

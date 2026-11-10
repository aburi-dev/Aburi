import configSchema from "@aburi/schema/aburi.config.v1.json" with { type: "json" }
import irSchema from "@aburi/schema/aburi.ir.v1.json" with { type: "json" }
import pluginSchema from "@aburi/schema/aburi.plugin.v1.json" with { type: "json" }
import { describe, expect, it } from "vitest"
import { LANGUAGE_ID_PATTERN } from "../src/index"

describe("the language token grammar", () => {
  it.each([
    ["an IR's LanguageId", irSchema.$defs.LanguageId.pattern],
    ["a plugin manifest's languageId", pluginSchema.properties.languageId.pattern],
    [
      "a config component override's languages",
      configSchema.$defs.ComponentOverride.properties.languages.items.pattern,
    ],
    ["a config lsp.servers key", configSchema.$defs.LspLanguageKey.pattern],
  ])("is the pattern the schema gives %s", (_, pattern) => {
    expect(pattern).toBe(LANGUAGE_ID_PATTERN.source)
  })
})

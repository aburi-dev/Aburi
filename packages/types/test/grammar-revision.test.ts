import irSchema from "@aburi/schema/aburi.ir.v1.json" with { type: "json" }
import pluginSchema from "@aburi/schema/aburi.plugin.v1.json" with { type: "json" }
import { describe, expect, it } from "vitest"
import { GRAMMAR_REVISION_PATTERN } from "../src/index"

describe("the grammar revision form", () => {
  it.each([
    [
      "an IR's lang PluginRef",
      irSchema.$defs.PluginRef.allOf[0]?.then.properties.grammarRevision.pattern,
    ],
    ["a plugin manifest's grammarRevision", pluginSchema.properties.grammarRevision.pattern],
  ])("is the pattern the schema gives %s", (_, pattern) => {
    expect(pattern).toBe(GRAMMAR_REVISION_PATTERN.source)
  })
})

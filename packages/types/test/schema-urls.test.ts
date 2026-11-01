import configSchema from "@aburi/schema/aburi.config.v1.json" with { type: "json" }
import diffSchema from "@aburi/schema/aburi.diff.v1.json" with { type: "json" }
import irSchema from "@aburi/schema/aburi.ir.v1.json" with { type: "json" }
import pluginSchema from "@aburi/schema/aburi.plugin.v1.json" with { type: "json" }
import { describe, expect, it } from "vitest"
import {
  CONFIG_SCHEMA_URL,
  DIFF_SCHEMA_URL,
  IR_SCHEMA_URL,
  isIRSchemaURL,
  PLUGIN_SCHEMA_URL,
} from "../src/index"

describe("the $schema a written document carries", () => {
  it.each([
    ["an IR", IR_SCHEMA_URL, irSchema],
    ["a diff", DIFF_SCHEMA_URL, diffSchema],
    ["a config", CONFIG_SCHEMA_URL, configSchema],
    ["a plugin manifest", PLUGIN_SCHEMA_URL, pluginSchema],
  ])("for %s is the $id of the schema it names, which that schema accepts", (_, url, schema) => {
    expect(url).toBe(schema.$id)
    expect(schema.properties.$schema.enum).toContain(url)
  })
})

describe("isIRSchemaURL", () => {
  it.each(irSchema.properties.$schema.enum)("accepts %s, as the IR schema does", (url) => {
    expect(isIRSchemaURL(url)).toBe(true)
  })

  it.each([
    ["a later IR version", "https://aburi.dev/schema/aburi.ir.v2.json"],
    ["another schema of the same host", DIFF_SCHEMA_URL],
    ["the IR file name alone", "aburi.ir.v1.json"],
    ["a value that is not a string", 1],
    ["an absent value", undefined],
  ])("refuses %s", (_, value) => {
    expect(isIRSchemaURL(value)).toBe(false)
  })
})

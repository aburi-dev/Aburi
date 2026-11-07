import { PLUGIN_SCHEMA_URL } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { effectsDrizzleManifest } from "../src/index"

describe("effectsDrizzleManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
    expect(effectsDrizzleManifest).toEqual({
      $schema: PLUGIN_SCHEMA_URL,
      name: "effects-drizzle",
      version: "0.0.0",
      type: "effects",
      engines: { aburi: "*" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: ["effects-plugin:drizzle"],
        frameworks: [],
      },
    })
  })
})

import { PLUGIN_SCHEMA_URL } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { effectsTrpcManifest } from "../src/index"

describe("effectsTrpcManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
    expect(effectsTrpcManifest).toEqual({
      $schema: PLUGIN_SCHEMA_URL,
      name: "effects-trpc",
      version: "0.0.0",
      type: "effects",
      engines: { aburi: "*" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: ["effects-plugin:trpc"],
        frameworks: [],
      },
    })
  })
})

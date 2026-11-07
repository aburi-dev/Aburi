import { PLUGIN_SCHEMA_URL } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { effectsPrismaManifest } from "../src/index"

describe("effectsPrismaManifest", () => {
  it("declares the plugin identity and no vocabulary of its own", () => {
    expect(effectsPrismaManifest).toEqual({
      $schema: PLUGIN_SCHEMA_URL,
      name: "effects-prisma",
      version: "0.0.0",
      type: "effects",
      engines: { aburi: "*" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: ["effects-plugin:prisma"],
        frameworks: [],
      },
    })
  })
})

import { describe, expect, it } from "vitest"
import { frameworkTrpcManifest, TRPC_EXT_KINDS, trpcFrameworkPlugin } from "../src/index"

describe("frameworkTrpcManifest", () => {
  it("declares the trpc framework, owning the framework:trpc prefixes and no effects", () => {
    expect(trpcFrameworkPlugin.manifest).toBe(frameworkTrpcManifest)
    expect(frameworkTrpcManifest).toMatchObject({
      name: "framework-trpc",
      type: "framework",
      provides: {
        effects: [],
        effectPrefixes: [],
        extKindPrefixes: ["framework:trpc"],
        derivedByPrefixes: ["framework:trpc"],
        frameworks: ["trpc"],
      },
    })
  })

  it("declares each extKind the classifier assigns, in order and no other", () => {
    expect(frameworkTrpcManifest.provides.extKinds.map((e) => e.id)).toEqual([...TRPC_EXT_KINDS])
  })
})

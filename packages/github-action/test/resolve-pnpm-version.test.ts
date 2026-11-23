import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { runScript } from "./fixtures/scripts"

const scratch = useScratchWorkspace("resolve-pnpm-version")

async function resolvedFor(manifest: string | null, requested = "") {
  if (manifest !== null) await scratch.writeSource("package.json", manifest)
  return runScript("resolve-pnpm-version.mjs", {
    env: { GITHUB_WORKSPACE: scratch.root, PNPM_VERSION: requested },
  })
}

const manifest = (fields: Record<string, unknown>) => JSON.stringify({ name: "shop", ...fields })

describe("resolve-pnpm-version.mjs", () => {
  it.each([
    ["a `packageManager` pin", manifest({ packageManager: "pnpm@10.12.1" })],
    [
      "a `packageManager` pin with its integrity hash",
      manifest({ packageManager: "pnpm@11.11.0+sha512.0123abcd" }),
    ],
    [
      "a `devEngines.packageManager` pin",
      manifest({ devEngines: { packageManager: { name: "pnpm", version: "^10.12.0" } } }),
    ],
  ])("passes no version beside %s, so the pin is what gets installed", async (_, json) => {
    expect(await resolvedFor(json)).toEqual({ status: 0, stdout: "", stderr: "" })
  })

  it.each<[string, string | null]>([
    ["no package.json", null],
    ["a package.json that pins nothing", manifest({ private: true })],
    ["a pin of another package manager", manifest({ packageManager: "yarn@4.5.0" })],
    [
      "a `devEngines.packageManager` of another package manager",
      manifest({ devEngines: { packageManager: { name: "npm", version: "10.9.0" } } }),
    ],
    ["a package.json that is not JSON", "{ name: shop"],
  ])("passes pnpm 10 for %s", async (_, json) => {
    expect(await resolvedFor(json)).toEqual({ status: 0, stdout: "10", stderr: "" })
  })

  it.each<[string, string | null]>([
    ["with no pin", null],
    ["beside a pin it equals", manifest({ packageManager: "pnpm@9.15.0" })],
  ])("passes a version the caller set as it is, %s", async (_, json) => {
    expect(await resolvedFor(json, "9.15.0")).toEqual({ status: 0, stdout: "9.15.0", stderr: "" })
  })
})

import { makeCall, useScratchWorkspace } from "@aburi/test-support"
import type { EffectPlugin } from "@aburi/types"
import { beforeEach, describe, expect, it } from "vitest"
import {
  scanStubs,
  stubCandidate,
  stubEffectsPlugin,
  stubLanguagePlugin,
} from "../fixtures/plugins"

const ALPHA = "stub:app.stub#alpha"
const ZETA = "stub:app.stub#zeta"

const workspace = useScratchWorkspace("declined-calls")

beforeEach(async () => {
  await workspace.writeSource("app.stub", "app")
})

/** `zeta` is written above `alpha`, and each calls `raw.run` on line 10, then on line 9. */
const language = stubLanguagePlugin({
  extractSymbols: () => [
    stubCandidate("zeta", { file: "app.stub" }),
    stubCandidate("alpha", { file: "app.stub" }),
  ],
  walkBody: () => ({
    rules: [],
    calls: [makeCall({ target: "raw.run", line: 10 }), makeCall({ target: "raw.run", line: 9 })],
  }),
})

const decliningAs = (name: string) => stubEffectsPlugin(name, () => ({ declined: `${name}:raw` }))

const scanWith = (...effects: EffectPlugin[]) =>
  scanStubs(workspace.root, { languages: [language], effects })

describe("scan — stats.declinedCalls", () => {
  it("orders the entries by symbolId, then by line as a number, whatever the source order", async () => {
    const result = await scanWith(decliningAs("effects-wary"))

    expect(result.ir.stats.declinedCalls?.map((entry) => [entry.symbolId, entry.line])).toEqual([
      [ALPHA, 9],
      [ALPHA, 10],
      [ZETA, 9],
      [ZETA, 10],
    ])
  })

  it("keeps one entry per declining plugin, by plugin name, and the call in calls[] once", async () => {
    const result = await scanWith(decliningAs("effects-wary"), decliningAs("effects-also"))

    const alphaLine9 = result.ir.stats.declinedCalls?.filter(
      (entry) => entry.symbolId === ALPHA && entry.line === 9,
    )
    expect(alphaLine9?.map((entry) => [entry.plugin, entry.reason])).toEqual([
      ["effects-also", "effects-also:raw"],
      ["effects-wary", "effects-wary:raw"],
    ])
    const alpha = result.ir.symbols.find((symbol) => symbol.id === ALPHA)
    expect(alpha?.calls.map((call) => [call.target, call.line])).toEqual([
      ["raw.run", 9],
      ["raw.run", 10],
    ])
  })

  it("changes stats.declinedCalls and nothing else in the Document, against a null", async () => {
    const declined = await scanWith(decliningAs("effects-wary"))
    const ignored = await scanWith(stubEffectsPlugin("effects-wary", () => null))

    expect(declined.ir.stats.declinedCalls).toHaveLength(4)
    expect(ignored.ir.stats.declinedCalls).toBeUndefined()
    expect(declined.ir).toEqual({
      ...ignored.ir,
      stats: { ...ignored.ir.stats, declinedCalls: declined.ir.stats.declinedCalls },
    })
  })
})

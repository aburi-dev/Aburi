import { changed, makeDiff, movedChanged, symbolAt } from "@aburi/test-support"
import type { SymbolChangeStatus } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { evaluateFailOn, type FailOnScope, parseFailOn } from "../src"
import { unlistedTripped } from "../src/status-filter"

const api = { apiChanged: true }

/** Two API changes in place, one moved with its API, and one moved within test code. */
const DIFF = makeDiff({
  symbols: [
    changed(symbolAt("src/total.ts", "total", 1), api),
    changed(symbolAt("src/tax.ts", "tax", 1), api),
    movedChanged(symbolAt("src/old.ts", "price", 1), symbolAt("src/new.ts", "price", 1), api),
    movedChanged(
      symbolAt("src/old.test.ts", "fixture", 1, { inTestFile: true }),
      symbolAt("src/new.test.ts", "fixture", 1, { inTestFile: true }),
      api,
    ),
  ],
})

function warning(
  failOn: string,
  statuses: readonly SymbolChangeStatus[],
  scope: FailOnScope = "all",
): string | null {
  const { firstTriggered } = evaluateFailOn(parseFailOn(failOn), DIFF, scope)
  if (firstTriggered === null) throw new Error(`--fail-on ${failOn} did not trip`)
  return unlistedTripped(firstTriggered, DIFF, statuses)
}

describe("unlistedTripped", () => {
  it.each([
    [
      "api-changed",
      ["changed"],
      "all",
      "2 of the 4 changes that tripped --fail-on api-changed (2 moved+changed)",
    ],
    [
      "api-changed",
      ["changed"],
      "non-test",
      "1 of the 3 changes that tripped --fail-on api-changed (1 moved+changed)",
    ],
    [
      "api-changed:>1",
      ["moved+changed"],
      "all",
      "2 of the 4 changes that tripped --fail-on api-changed:>1 (2 changed)",
    ],
    [
      "api-changed",
      ["added"],
      "all",
      "every change that tripped --fail-on api-changed (2 changed, 2 moved+changed)",
    ],
  ] as const)(
    "--fail-on %s under %j, counting %s changes, warns of %s",
    (failOn, statuses, scope, what) => {
      expect(warning(failOn, statuses, scope)).toBe(`⚠ --filter leaves out of diff.md ${what}.`)
    },
  )

  it("says nothing when the report lists every change the clause counted", () => {
    expect(warning("api-changed", ["changed", "moved+changed"])).toBeNull()
  })
})

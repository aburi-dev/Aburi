import { describe, expect, it, vi } from "vitest"
import { parseSource } from "./fixtures/ctx"

vi.mock("../src/call-signature-separator", () => ({
  callSignatureSeparators: () => {
    throw new Error("out of memory")
  },
}))

describe("a repair that throws beside one that holds", () => {
  it("keeps the repair that holds and names the one that failed", async () => {
    const source = [
      'export const b = g<typeof import("./m")>()',
      "type S = {",
      "  (): A",
      "  <U>(u: U): U",
      "}",
      "",
    ].join("\n")
    const result = await parseSource(source)
    const [failure, ...rest] = result.errors
    expect(failure?.message).toBe(
      "reparse of generic call signatures failed, keeping the parse without it: out of memory",
    )
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.filter((error) => error.line === 1)).toEqual([])
  })
})

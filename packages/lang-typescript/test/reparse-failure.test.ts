import { describe, expect, it, vi } from "vitest"
import { parseSource } from "./fixtures/ctx"

vi.mock("../src/reparse", async (importActual) => ({
  ...(await importActual<typeof import("../src/reparse")>()),
  reparsePatched: () => {
    throw new Error("out of memory")
  },
}))

describe("a reparse that throws", () => {
  it.each([
    ["an import() type", 'export const b = g<typeof import("./m")>()\n'],
    ["a generic call signature on its own line", "type S = {\n  (): A\n  <U>(u: U): U\n}\n"],
  ])(
    "keeps the first parse of %s and names the failed pass beside its errors",
    async (_label, source) => {
      const result = await parseSource(source)
      expect(result.tree).not.toBeNull()
      expect(result.errors[0]).toEqual({
        message: "reparse failed, keeping the first parse: out of memory",
        line: 1,
        column: 1,
        recoverable: true,
      })
      expect(result.errors.slice(1).map((e) => e.message)).toContain("syntax error")
    },
  )
})

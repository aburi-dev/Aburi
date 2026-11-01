import { describe, expect, it } from "vitest"
import { AsyncMemo } from "../src/index"

describe("AsyncMemo", () => {
  it("computes a key once, however many callers ask before it settles", async () => {
    const memo = new AsyncMemo<string, number>()
    let computed = 0
    const compute = async () => ++computed
    const answers = await Promise.all([memo.get("k", compute), memo.get("k", compute)])

    expect(answers).toEqual([1, 1])
    expect(await memo.get("k", compute)).toBe(1)
    expect(computed).toBe(1)
  })

  it("keeps a rejection, so a failed key is not retried", async () => {
    const memo = new AsyncMemo<string, number>()
    let attempts = 0
    const compute = async () => {
      attempts++
      throw new Error("unreadable")
    }

    await expect(memo.get("k", compute)).rejects.toThrow("unreadable")
    await expect(memo.get("k", compute)).rejects.toThrow("unreadable")
    expect(attempts).toBe(1)
  })

  it.each<[string, (memo: AsyncMemo<string, string>) => Promise<unknown>, string]>([
    ["answers a primed key without computing it", async () => {}, "primed"],
    [
      "leaves a key computed before it was primed",
      (memo) => memo.get("k", async () => "computed"),
      "computed",
    ],
  ])("%s", async (_case, before, expected) => {
    const memo = new AsyncMemo<string, string>()
    await before(memo)
    memo.prime("k", "primed")

    expect(await memo.get("k", async () => "computed afresh")).toBe(expected)
  })
})

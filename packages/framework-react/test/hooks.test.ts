import { describe, expect, it } from "vitest"
import { bodyCallsAnotherHook, matchesHookNaming } from "../src/index"
import { candidateNamed } from "./fixtures/symbol"

describe("matchesHookNaming", () => {
  it.each([
    ["useState", true],
    ["useEffect", true],
    ["useMyHook", true],
    ["use", false],
    ["useful", false],
    ["usable", false],
    ["User", false],
    ["State", false],
    ["", false],
  ])("matchesHookNaming(%j) === %j", (leaf, expected) => {
    expect(matchesHookNaming(leaf)).toBe(expected)
  })
})

describe("bodyCallsAnotherHook", () => {
  it.each([
    ["a hook called directly", true, "function useThing() { const [x] = useState(0); return x }"],
    [
      "a hook called on a namespace",
      true,
      "function useThing() { React.useEffect(() => {}, []); return null }",
    ],
    [
      "a hook on a client's procedure path",
      true,
      "function useThing() { return trpc.viewer.me.useQuery() }",
    ],
    [
      "a method of a lowercase object named like a hook",
      false,
      "function useThing() { vi.useFakeTimers(); return null }",
    ],
    ["only other functions", false, "function useThing() { return doWork() }"],
  ])("reads a body calling %s as calling a hook: %s", async (_label, expected, source) => {
    const { bodyNode } = await candidateNamed(source, "useThing")
    expect(bodyCallsAnotherHook(bodyNode)).toBe(expected)
  })

  it("returns false when there is no body", () => {
    expect(bodyCallsAnotherHook(null)).toBe(false)
  })
})

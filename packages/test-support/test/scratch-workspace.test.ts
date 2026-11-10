import { describe, expect, it } from "vitest"
import { useScratchWorkspace } from "../src"

const workspace = useScratchWorkspace("scratch-workspace")

function readWhileCollecting(): unknown {
  try {
    return workspace.root
  } catch (error) {
    return error
  }
}

const collected = readWhileCollecting()

describe("useScratchWorkspace", () => {
  it("refuses its root to code that runs while the tests are collected", () => {
    expect(collected).toEqual(
      new Error(
        'the "scratch-workspace" scratch workspace has no directory outside a test or its hooks',
      ),
    )
  })
})

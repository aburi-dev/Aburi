import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { assertRunnable, cliEntry } from "../checkout.mjs"

describe("assertRunnable", () => {
  it("names a baseline checkout whose CLI was never built", () => {
    const baseline = resolve(tmpdir(), "aburi-bench-unbuilt-checkout")
    expect(() => assertRunnable(resolve(tmpdir(), "aburi-bench-work"), baseline)).toThrow(
      `${cliEntry(baseline)} is missing. Run \`pnpm build\` in ${baseline} first.`,
    )
  })
})

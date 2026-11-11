import { describe, expect, it } from "vitest"
import { CliError } from "../src"
import { describedForThread, rebuiltFromThread } from "../src/thread-errors"

class RegistryError extends Error {
  override readonly name = "RegistryError"
  readonly code = "vocab-undeclared"
}

const acrossThread = (error: unknown): unknown =>
  rebuiltFromThread(structuredClone(describedForThread(error)))

/** Each error of the chain as its name, message, code and stack, then a cause that is no error. */
function chainOf(error: unknown): unknown[] {
  const chain: unknown[] = []
  let at = error
  while (at instanceof Error) {
    const { name, message, stack } = at
    chain.push({ name, message, code: (at as { code?: unknown }).code, stack })
    at = at.cause
  }
  return at === undefined ? chain : [...chain, at]
}

describe("an error sent across a thread", () => {
  it("keeps the name, message, code and stack of each error it was caused by", () => {
    const registry = new RegistryError("extKind id is not declared", { cause: "a value" })
    const error = new CliError("Plugin lang-stub emitted an undeclared extKind", "plugin-error", {
      cause: new Error("the file's extraction stopped", { cause: registry }),
    })

    const rebuilt = acrossThread(error)

    expect(rebuilt).toBeInstanceOf(CliError)
    expect(chainOf(rebuilt)).toEqual(chainOf(error))
  })

  it("ends a chain of causes that loops at the first error it repeats", () => {
    const first = new Error("first")
    const second = new Error("second", { cause: first })
    first.cause = second

    expect(chainOf(acrossThread(first)).map((link) => (link as Error).message)).toEqual([
      "first",
      "second",
    ])
  })
})

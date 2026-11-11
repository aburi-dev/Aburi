import { describe, expect, it } from "vitest"
import { isSymbolChangeStatus, SYMBOL_CHANGE_STATUSES } from "../src/index"

describe("SYMBOL_CHANGE_STATUSES", () => {
  it("is frozen, so no caller widens what every reader of it accepts", () => {
    expect(Object.isFrozen(SYMBOL_CHANGE_STATUSES)).toBe(true)
  })
})

describe("isSymbolChangeStatus", () => {
  it.each(SYMBOL_CHANGE_STATUSES)("takes %s", (status) => {
    expect(isSymbolChangeStatus(status)).toBe(true)
  })

  it.each([
    "renamed",
    "Added",
    "removed:duplicate",
    "",
    "toString",
    "__proto__",
    7,
    null,
    undefined,
  ])("refuses %j", (value) => {
    expect(isSymbolChangeStatus(value)).toBe(false)
  })
})

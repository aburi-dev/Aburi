import { errorFrom, rule } from "@aburi/test-support"
import type { Rule } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { ProjectionInvariantError, ruleRow } from "../src"

describe("ruleRow", () => {
  it.each<[string, Rule, string]>([
    [
      "a guard by its condition",
      rule({ type: "guard", line: 5, condition: "x > 0" }),
      "- guard: `x > 0` (L5)",
    ],
    [
      "a throw by what it throws",
      rule({ type: "throw", line: 8, what: "new E()" }),
      "- throw: `new E()` (L8)",
    ],
    [
      "a return by its expression",
      rule({ type: "return", line: 20, expr: "value" }),
      "- return: `value` (L20)",
    ],
    [
      "a branch by its condition",
      rule({ type: "branch", line: 6, condition: "user.isAdmin" }),
      "- branch: `user.isAdmin` (L6)",
    ],
    [
      "a value by its expression",
      rule({ type: "value", line: 1, expr: 'Red = "red"' }),
      '- value: `Red = "red"` (L1)',
    ],
    [
      "a loop by its kind",
      rule({ type: "loop", line: 30, loopKind: "for" }),
      "- loop (`for`) (L30)",
    ],
    [
      "a loop by its header and its kind",
      rule({ type: "loop", line: 30, loopKind: "while", condition: "q.size > 0" }),
      "- loop: `q.size > 0` (`while`) (L30)",
    ],
    [
      "a case by its label",
      rule({ type: "case", line: 52, condition: '"admin"' }),
      '- case: `"admin"` (L52)',
    ],
    ["a try, which carries no payload", rule({ type: "try", line: 40 }), "- try (L40)"],
    [
      "a switch by its condition",
      rule({ type: "switch", line: 50, condition: "kind" }),
      "- switch: `kind` (L50)",
    ],
    [
      "a match by its condition",
      rule({ type: "match", line: 60, condition: "kind" }),
      "- match: `kind` (L60)",
    ],
  ])("writes %s", (_, input, row) => {
    expect(ruleRow(input)).toEqual([row])
  })

  it.each([
    { type: "guard", condition: "" },
    { type: "branch", condition: "" },
    { type: "switch", condition: "" },
    { type: "case", condition: "" },
    { type: "match", condition: "" },
    { type: "throw", what: "" },
    { type: "return", expr: "" },
    { type: "value", expr: "" },
  ] as const)(
    "names an empty $type payload instead of rendering a row that trails off",
    (payload) => {
      expect(ruleRow(rule({ ...payload, line: 5 }))).toEqual([`- ${payload.type}: (empty) (L5)`])
    },
  )

  it.each<[Rule["type"], string]>([
    ["guard", "condition"],
    ["branch", "condition"],
    ["switch", "condition"],
    ["case", "condition"],
    ["match", "condition"],
    ["throw", "what"],
    ["return", "expr"],
    ["value", "expr"],
    ["loop", "loopKind"],
  ])("refuses a %s without its %s, naming the field and the rule", async (type, field) => {
    const error = await errorFrom(ProjectionInvariantError, () => ruleRow(rule({ type, line: 5 })))
    expect(error).toMatchObject({ field, subject: `Rule(type=${type}, line=5)` })
  })

  it("fences a loop header too long to sit inline, keeping the kind on the item", () => {
    const header = `let i = 0; ${"i < limit && ".repeat(8)}ok; i++`

    expect(ruleRow(rule({ type: "loop", line: 7, loopKind: "for", condition: header }))).toEqual([
      "- loop (`for`) (L7):",
      "  ```",
      `  ${header}`,
      "  ```",
    ])
  })
})

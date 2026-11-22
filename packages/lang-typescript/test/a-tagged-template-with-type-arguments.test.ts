import { describe, expect, it } from "vitest"
import { BACKSLASH, parseErrorsOf } from "./fixtures/ctx"

describe("a tagged template with type arguments", () => {
  it.each([
    ["an array type", "export const r = sql<Row[]>`select 1`\n"],
    ["two type arguments", "export const r = f<A, B>`x`\n"],
    [
      "on an awaited member, with a substitution",
      `export const r = async () => await db.$queryRaw<Row[]>\`select \${a}\`\n`,
    ],
    ["across lines", "export const r = sql<Row[]>`\n  select 1\n`\n"],
    ["holding an escape only a tag allows", `export const r = raw<A[]>\`C:${BACKSLASH}Users\`\n`],
  ])("parses clean with %s", async (_label, source) => {
    expect(await parseErrorsOf(source)).toEqual([])
    expect(await parseErrorsOf(source, "src/a.tsx")).toEqual([])
  })

  it.each([
    ["a broken substitution", `export const r = sql<Row[]>\`\${a b}\`\n`],
    ["a type argument list that never closes", "export const r = sql<Row[]`x`\n"],
  ])("still reports %s", async (_label, source) => {
    expect(await parseErrorsOf(source)).not.toEqual([])
  })
})

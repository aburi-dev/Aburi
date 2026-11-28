import { describe, expect, it } from "vitest"
import { BACKSLASH, parseErrorsOf, walkOf } from "./fixtures/ctx"

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

describe("the call a tagged template with type arguments makes", () => {
  const callsIn = async (body: string) => {
    const walk = await walkOf(`export async function f() {\n  ${body}\n}\n`, "ts:src/a.ts#f")
    return walk.calls.map(({ target, dynamicReceiver, inAwait }) => ({
      target,
      dynamic: dynamicReceiver === true,
      inAwait,
    }))
  }

  it.each([
    [
      "an array type, which the grammar completes with a `!`",
      "return prisma.$queryRaw<User[]>`SELECT * FROM users`",
      [{ target: "prisma.$queryRaw", dynamic: false, inAwait: false }],
    ],
    ["two array types", "return f<A[], B[]>`x`", [{ target: "f", dynamic: false, inAwait: false }]],
    [
      "an `await` the completion holds",
      `await db.$queryRaw<Row[]>\`select \${id}\``,
      [{ target: "db.$queryRaw", dynamic: false, inAwait: true }],
    ],
    [
      "a type that reads as an expression, which the grammar reads as two comparisons",
      "return sql<number>`count(*)`",
      [{ target: "sql", dynamic: false, inAwait: false }],
    ],
    [
      "a qualified type read as comparisons, behind an `await`",
      "const rows = await db.$queryRaw<Prisma.User>`x`",
      [{ target: "db.$queryRaw", dynamic: false, inAwait: true }],
    ],
    [
      "a chain on the result, after the tag",
      "const n = sql<number>`count(*)`.mapWith(Number)",
      [
        { target: "sql", dynamic: false, inAwait: false },
        { target: "sql.mapWith", dynamic: true, inAwait: false },
      ],
    ],
    [
      "a call in a substitution, after the tag",
      `return sql<number>\`select \${pick(id)}\``,
      [
        { target: "sql", dynamic: false, inAwait: false },
        { target: "pick", dynamic: false, inAwait: false },
      ],
    ],
  ])("is the tag's, for %s", async (_label, body, calls) => {
    expect(await callsIn(body)).toEqual(calls)
  })

  it.each([
    ["a comparison against a template", "return a < b + 1 > `x`"],
    [
      "a union type, whose `>` the grammar binds to its last member",
      "return sql<number | null>`x`",
    ],
    ["two names, which the grammar reads as a sequence", "return f<A, B>`x`"],
  ])("is none for %s", async (_label, body) => {
    expect(await callsIn(body)).toEqual([])
  })
})

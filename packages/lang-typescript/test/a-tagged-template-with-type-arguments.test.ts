import { describe, expect, it } from "vitest"
import { BACKSLASH, parseErrorsOf, symbolsOf, walkFirstSymbol, walksOf } from "./fixtures/ctx"

/** A path whose `\u` opens no escape, which only a tag may hold. */
const RAW_PATH = ["C:", "Users", "u", "Aburi"].join(BACKSLASH)

describe("a tagged template with type arguments", () => {
  it.each([
    ["an array type", "export const r = sql<Row[]>`select 1`\n"],
    ["two array types", "export const r = f<A[], B[]>`x`\n"],
    [
      "on an awaited member, with a substitution",
      `export const r = async () => await db.$queryRaw<Row[]>\`select \${a}\`\n`,
    ],
    ["across lines", "export const r = sql<Row[]>`\n  select 1\n`\n"],
    ["as a concise arrow body", "export const r = (p: P) => p.$queryRaw<Row[]>`select 1`\n"],
    ["holding an escape only a tag allows", `export const r = raw<A[]>\`${RAW_PATH}\`\n`],
    [
      "holding an escape only a tag allows, after a type the grammar reads as a comparison",
      `export const r = raw<number>\`${RAW_PATH}\`\n`,
    ],
  ])("parses clean with %s", async (_label, source) => {
    expect(await parseErrorsOf(source)).toEqual([])
    expect(await parseErrorsOf(source, "src/a.tsx")).toEqual([])
  })

  it.each([
    ["a broken substitution", `export const r = sql<Row[]>\`\${a b}\`\n`],
    ["a type argument list that never closes", "export const r = sql<Row[]`x`\n"],
    [
      "an escape the template opens with, which the grammar recovers from without a template",
      `export const r = raw<Row[]>\`${BACKSLASH}u{zz}\`\n`,
    ],
  ])("still reports %s", async (_label, source) => {
    expect(await parseErrorsOf(source)).not.toEqual([])
  })

  it.each([
    ["the `!` the grammar completes an array type with", "export const r = sql<Row[]>`x`\n"],
    [
      "an escape in a template a comparison holds",
      `export const r = raw < number > \`${RAW_PATH}\`\n`,
    ],
  ])("still reports %s in JavaScript, which has no type arguments", async (_label, source) => {
    expect(await parseErrorsOf(source, "src/a.js")).not.toEqual([])
  })
})

describe("the call a tagged template with type arguments makes", () => {
  const callsIn = async (body: string, path = "src/a.ts") => {
    const walk = await walkFirstSymbol(`export async function f() {\n  ${body}\n}\n`, path)
    return walk.calls.map(({ target, dynamicReceiver, inAwait }) => ({
      target,
      dynamic: dynamicReceiver === true,
      inAwait,
    }))
  }
  const call = (target: string, more: { dynamic?: boolean; inAwait?: boolean } = {}) => ({
    target,
    dynamic: false,
    inAwait: false,
    ...more,
  })

  it.each([
    [
      "an array type, which the grammar completes with a `!`",
      "return prisma.$queryRaw<User[]>`SELECT * FROM users`",
      [call("prisma.$queryRaw")],
    ],
    ["two array types", "return f<A[], B[]>`x`", [call("f")]],
    [
      "an `await` the completion holds",
      `await db.$queryRaw<Row[]>\`select \${id}\``,
      [call("db.$queryRaw", { inAwait: true })],
    ],
    ["a type the grammar reads as two comparisons", "return sql<number>`count(*)`", [call("sql")]],
    [
      "a qualified type read as comparisons, behind an `await`",
      "const rows = await db.$queryRaw<Prisma.User>`x`",
      [call("db.$queryRaw", { inAwait: true })],
    ],
    [
      "a union type, whose `>` the grammar binds to its last member",
      "return sql<number | null>`x`",
      [call("sql")],
    ],
    ["two names, which the grammar reads as a sequence", "return f<A, B>`x`", [call("f")]],
    [
      "a generic type closed by a `>>` the grammar reads as a shift",
      "return prisma.$queryRaw<Array<{ id: number }>>`x`",
      [call("prisma.$queryRaw")],
    ],
    ["a generic type closed apart", "return sql<Promise<number> >`x`", [call("sql")]],
    ["a generic type of two names", "return sql<Map<A, B>>`x`", [call("sql")]],
    ["a generic type of a name and a type", "return sql<Record<string, number>>`x`", [call("sql")]],
    ["an indexed generic type", 'return sql<Pick<User, "id">[]>`x`', [call("sql")]],
    ["a comment in the type arguments", "return sql</* n */ number>`x`", [call("sql")]],
    ["type arguments over lines", "return sql<\n    number\n  >`x`", [call("sql")]],
    ["an operand of `+`", "return 1 + sql<number>`x`", [call("sql")]],
    ["an operand of `+` completed with a `!`", "return a + sql<Row[]>`x`", [call("sql")]],
    ["the left operand of `+`", "return sql<number>`x` + 1", [call("sql")]],
    ["the operand of `!`", "return !sql<number>`x`", [call("sql")]],
    ["the operand of `typeof`", "return typeof sql<number>`x`", [call("sql")]],
    ["a substitution of an untagged template", `return \`\${sql<number>\`x\`}\``, [call("sql")]],
    [
      "type arguments the grammar splits across a call's arguments",
      "return g(a < b, c > `x`)",
      [call("g"), call("a")],
    ],
    [
      "a chain on the result, recorded outermost first",
      "const n = sql<number>`count(*)`.mapWith(Number)",
      [call("sql.mapWith", { dynamic: true }), call("sql")],
    ],
    [
      "a call in a substitution, after the tag",
      `return sql<number>\`select \${pick(id)}\``,
      [call("sql"), call("pick")],
    ],
  ])("is the tag's, for %s", async (_label, body, calls) => {
    expect(await callsIn(body)).toEqual(calls)
  })

  it.each([
    ["a comparison against a template", "return a < b + 1 > `x`"],
    ["comparisons `&&` joins", "return a < b && c > `x`"],
    ["comparisons `||` joins", "return a < b || c > `x`"],
  ])("is none for %s", async (_label, body) => {
    expect(await callsIn(body)).toEqual([])
  })

  it.each([
    ["two comparisons", "return a < b > `x`"],
    ["the spelling a type argument would take", "return sql<number>`count(*)`"],
  ])("is none in JavaScript, which has no type arguments, for %s", async (_label, body) => {
    expect(await callsIn(body, "src/a.js")).toEqual([])
  })
})

describe("a tagged template reads the same with type arguments as without", () => {
  const TYPE_ARGUMENTS = ["<Row[]>", "<number>"]

  // Rule texts quote the source, which differs by the type arguments alone.
  const readingOf = async (source: string, typeArguments = "") => {
    const walks = await walksOf(source)
    const reading = (await symbolsOf(source)).map((symbol) => {
      const walk = walks.get(symbol.id)
      return {
        id: symbol.id,
        kind: symbol.kind,
        lines: [symbol.source.startLine, symbol.source.endLine],
        returns: symbol.returns ?? null,
        calls: walk?.calls.map((c) => ({
          target: c.target,
          dynamic: c.dynamicReceiver === true,
          inAwait: c.inAwait,
          receiverCall: c.receiverCall?.target ?? null,
          localHead: c.localHead === true,
          unboundHead: c.unboundHead === true,
        })),
        rules: walk?.rules.map((r) => [r.type, r.expr ?? r.condition ?? r.what]),
      }
    })
    const unspelled: typeof reading = JSON.parse(
      JSON.stringify(reading).replaceAll(typeArguments, ""),
    )
    return unspelled
  }

  it.each([
    ["returned", (tag: string) => `export function f() {\n  return ${tag}\n}\n`],
    ["awaited", (tag: string) => `export async function f() {\n  return await ${tag}\n}\n`],
    ["a concise arrow body", (tag: string) => `export const f = (db: Db) => db.${tag}\n`],
    ["an exported const", (tag: string) => `export const q = ${tag}\n`],
    ["the default export", (tag: string) => `export default ${tag}\n`],
    ["an object entry", (tag: string) => `export const queries = { count: ${tag} }\n`],
    [
      "the receiver of a call",
      (tag: string) => `export function f() {\n  return ${tag}.mapWith(Number)\n}\n`,
    ],
    [
      "the value of a name a call is made on",
      (tag: string) => `export function f() {\n  const q = ${tag}\n  return q.run()\n}\n`,
    ],
    ["an operand", (tag: string) => `export function f() {\n  return 1 + ${tag}\n}\n`],
  ])("as %s", async (_label, written) => {
    const untyped = await readingOf(written("sql`select\n  1`"))

    expect(untyped.flatMap((symbol) => symbol.calls ?? []).length).toBeGreaterThan(0)
    for (const typeArguments of TYPE_ARGUMENTS) {
      const source = written(`sql${typeArguments}\`select\n  1\``)
      expect(await readingOf(source, typeArguments)).toEqual(untyped)
    }
  })
})

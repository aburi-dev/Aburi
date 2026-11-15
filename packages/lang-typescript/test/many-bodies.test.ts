import { describe, expect, it } from "vitest"
import { walksOf } from "./fixtures/ctx"
import { readingNodes } from "./fixtures/node-reads"

async function nodeReads(source: string): Promise<number> {
  let reads = 0
  await readingNodes(
    () => {
      reads += 1
    },
    () => walksOf(source),
  )
  return reads
}

const lines = (count: number, line: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => line(i)).join("\n")

const routes = (count: number) =>
  `new Hono()\n${lines(count, (i) => `  .get("/p${i}", (c) => c.json(${i}))`)}`

const FEW = 10
const MANY = 400

describe("a Symbol of many bodies", () => {
  it.each([
    ["a module of many statements", (count: number) => lines(count, (i) => `if (f${i}) run${i}()`)],
    [
      "a const whose call is handed many functions",
      (count: number) =>
        `export const app = compose(${lines(count, (i) => `(c) => c.step${i}(),`)})`,
    ],
  ])("reads nodes in proportion to %s", async (_, shape) => {
    const few = await nodeReads(shape(FEW))
    const many = await nodeReads(shape(MANY))
    // Between linear and quadratic growth on purpose, so the guard is neither tight nor blind.
    expect(many).toBeLessThan(few * (MANY / FEW) * 2)
  })

  it("reads a const chaining many handlers about as a function returning the chain does", async () => {
    const asConst = await nodeReads(`export const app = ${routes(MANY)}`)
    const inFunction = await nodeReads(`export function app() {\n  return ${routes(MANY)}\n}`)
    // Naming each call of a chain reads the chain below it, wherever the chain is written, so the
    // function measures what the chain itself costs.
    expect(asConst).toBeLessThan(inFunction * 1.5)
  })
})

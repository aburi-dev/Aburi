import type { ImportEdge, SymbolClassification } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { classifyDecorated, makeImport, NEST, reexported } from "./fixtures/symbol"

/** An import of `name` from `source`, as the scan hands it over once it traced `source` outside the workspace. */
function foreign(source: string, line = 1, name = "Controller"): ImportEdge {
  return reexported(makeImport(source, [name], line), { [name]: source })
}

/** The extKind and the confidence, an omitted one read as the `high` it means. */
function rated(result: SymbolClassification | null): [string | null, string] | null {
  return result === null ? null : [result.extKind ?? null, result.confidence ?? "high"]
}

describe("classifyNestjsSymbol — how far a bare decorator's import is trusted", () => {
  it.each([
    ["imported from @nestjs/common", "high", [makeImport(NEST, ["Controller"])]],
    [
      "imported from a module the scan did not place outside the workspace",
      "medium",
      [makeImport("routing-controllers", ["Controller"])],
    ],
    [
      "imported through a barrel the scan could not follow, which looks like any foreign module",
      "medium",
      [makeImport("../common", ["Controller"])],
    ],
    [
      "imported through a barrel that re-exports it from @nestjs/common",
      "high",
      [reexported(makeImport("@app/common", ["Controller"]), { Controller: NEST })],
    ],
    [
      "imported through a barrel that re-exports only other names from @nestjs/common",
      "medium",
      [reexported(makeImport("@app/common", ["Controller"]), { Get: NEST })],
    ],
    ["the file binds to nothing", "high", [makeImport("./unrelated", ["helper"])]],
    [
      "bound twice, the NestJS edge first",
      "high",
      [makeImport(NEST, ["Controller"], 1), makeImport("./x", ["Controller"], 2)],
    ],
    [
      "bound twice, the NestJS edge second",
      "high",
      [makeImport("./x", ["Controller"], 1), makeImport(NEST, ["Controller"], 2)],
    ],
    [
      "bound twice, the edge re-exported from @nestjs/common second",
      "high",
      [
        makeImport("./x", ["Controller"], 1),
        reexported(makeImport("@app/common", ["Controller"], 2), { Controller: NEST }),
      ],
    ],
    [
      "bound twice, the edge traced to a competing library first",
      "medium",
      [foreign("routing-controllers", 1), makeImport("./x", ["Controller"], 2)],
    ],
    [
      "bound twice, the edge traced to a competing library second",
      "medium",
      [makeImport("./x", ["Controller"], 1), foreign("routing-controllers", 2)],
    ],
  ])("rates @Controller %s at %s", (_label, confidence, imports) => {
    expect(rated(classifyDecorated("class", ["Controller"], imports))).toEqual([
      "framework:nestjs:controller",
      confidence,
    ])
  })

  it.each([
    ["imported from it directly", [foreign("routing-controllers")]],
    [
      "imported through a barrel that re-exports it",
      [
        reexported(makeImport("@app/common", ["Controller"]), {
          Controller: "routing-controllers",
        }),
      ],
    ],
    [
      "bound by a default import",
      [
        reexported(makeImport("routing-controllers", ["default as Controller"]), {
          default: "routing-controllers",
        }),
      ],
    ],
  ])("refuses @Controller the scan traced to a competing library, %s", (_label, imports) => {
    expect(classifyDecorated("class", ["Controller"], imports)).toBeNull()
  })

  it("keeps a method's route when the scan refuses only its other decorator", () => {
    const imports = [makeImport(NEST, ["Get"], 1), foreign("routing-controllers", 2, "UseGuards")]
    const result = classifyDecorated("method", ["UseGuards", "Get"], imports)

    expect(rated(result)).toEqual(["framework:nestjs:route", "high"])
    expect(result?.decoratorBoundaries).toEqual({ Get: true })
  })

  it.each([
    ["@nestjs/common", "high"],
    ["@nestjs/microservices", "high"],
    ["@nestjs/websockets", "high"],
    ["@nestjs/graphql", "high"],
    ["@nestjsx/common", "medium"],
    ["nestjs", "medium"],
    ["@nest/common", "medium"],
  ])("rates an import from %s at %s — the @nestjs/ scope is what counts", (source, confidence) => {
    expect(
      rated(classifyDecorated("class", ["Injectable"], [makeImport(source, ["Injectable"])])),
    ).toEqual(["framework:nestjs:provider", confidence])
  })

  it.each([
    [
      "the NestJS decorator wins",
      ["Controller", "Injectable"],
      ["framework:nestjs:controller", "high"],
    ],
    [
      "the foreign decorator wins",
      ["Injectable", "Controller"],
      ["framework:nestjs:provider", "medium"],
    ],
  ])(
    "takes a class's confidence from the decorator that won the role (%s)",
    (_label, decorators, expected) => {
      const imports = [makeImport(NEST, ["Controller"], 1), makeImport("./di", ["Injectable"], 2)]
      const result = classifyDecorated("class", decorators, imports)

      expect(rated(result)).toEqual(expected)
      expect(result?.decoratorBoundaries).toEqual({ Injectable: true, Controller: true })
    },
  )

  it.each([
    [
      "a foreign route decorator",
      ["UseGuards", "Get"],
      [makeImport(NEST, ["UseGuards"], 1), makeImport("./local", ["Get"], 2)],
      "medium",
    ],
    [
      "a foreign handler decorator",
      ["Get", "UseGuards"],
      [makeImport(NEST, ["Get"], 1), makeImport("./local", ["UseGuards"], 2)],
      "high",
    ],
  ])(
    "takes a method's confidence from its route decorator, not its handler (%s)",
    (_label, decorators, imports, confidence) => {
      const result = classifyDecorated("method", decorators, imports)

      expect(rated(result)).toEqual(["framework:nestjs:route", confidence])
      expect(result?.derivedBy).toBe("framework:nestjs:route:Get")
      expect(result?.decoratorBoundaries).toEqual({ Get: true, UseGuards: true })
    },
  )
})

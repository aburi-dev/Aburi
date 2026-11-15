import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { nestjsFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("decorator-import")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
  })

/** The source below, parameterized on the import line that supplies its two decorators. */
function controllerSource(importLine: string | null): string {
  return [
    ...(importLine === null ? [] : [importLine, ``]),
    `@Ctrl("/d")`,
    `export class DController {`,
    `  @Fetch("/list")`,
    `  list() { return [] }`,
    `}`,
    ``,
  ].join("\n")
}

describe("scan — decorator provenance through @aburi/framework-nestjs", () => {
  it("classifies decorators renamed on import, and flags them on the Symbol", async () => {
    await workspace.writeSource(
      "src/d.controller.ts",
      controllerSource(`import { Controller as Ctrl, Get as Fetch } from "@nestjs/common"`),
    )

    const result = await scanWorkspace()
    const controller = symbolNamed(result, "DController")
    const route = symbolNamed(result, "DController.list")

    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(route.extKind).toBe("framework:nestjs:route")
    expect(controller.decorators.map((d) => [d.name, d.boundary])).toEqual([["Ctrl", true]])
    expect(route.decorators.map((d) => [d.name, d.boundary])).toEqual([["Fetch", true]])
    expect(route.derivedBy).toContain("framework:nestjs:route:Get")
    expect(controller.confidence).toBe("high")
  })

  it("takes the written name when nothing in the file binds it", async () => {
    await workspace.writeSource("src/d2.controller.ts", controllerSource(null))

    const result = await scanWorkspace()
    expect(symbolNamed(result, "DController").extKind).toBeNull()
    expect(symbolNamed(result, "DController.list").extKind).toBeNull()
  })

  it("still classifies vocabulary written under its own name with no import at all", async () => {
    await workspace.writeSource(
      "src/d4.controller.ts",
      [
        `@Controller("/d4")`,
        `export class D4Controller {`,
        `  @Get("/list")`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    expect(symbolNamed(result, "D4Controller").extKind).toBe("framework:nestjs:controller")
    expect(symbolNamed(result, "D4Controller.list").extKind).toBe("framework:nestjs:route")
    expect(symbolNamed(result, "D4Controller").confidence).toBe("high")
  })

  it("ties a namespace-imported decorator back to the module it was written through", async () => {
    await workspace.writeSource(
      "src/d5.controller.ts",
      [
        `import * as nest from "@nestjs/common"`,
        ``,
        `@nest.Controller("/d5")`,
        `export class D5Controller {`,
        `  @nest.Get("/list")`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const controller = symbolNamed(result, "D5Controller")
    const route = symbolNamed(result, "D5Controller.list")

    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.confidence).toBe("high")
    expect(controller.decorators.map((d) => [d.name, d.qualifier, d.boundary])).toEqual([
      ["Controller", "nest", true],
    ])
    expect(route.extKind).toBe("framework:nestjs:route")
    expect(route.derivedBy).toContain("framework:nestjs:route:Get")
  })

  it("classifies a decorator written in parentheses as the one it encloses", async () => {
    await workspace.writeSource(
      "src/d6.controller.ts",
      [
        `import { Controller } from "@nestjs/common"`,
        `import * as nest from "@nestjs/common"`,
        ``,
        `@(Controller)`,
        `export class D6Controller {}`,
        ``,
        `@(nest`,
        `  .Controller)`,
        `export class D7Controller {}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const bare = symbolNamed(result, "D6Controller")
    const qualified = symbolNamed(result, "D7Controller")

    expect(bare.extKind).toBe("framework:nestjs:controller")
    expect(bare.decorators.map((d) => [d.name, d.qualifier, d.boundary])).toEqual([
      ["Controller", undefined, true],
    ])
    expect(qualified.extKind).toBe("framework:nestjs:controller")
    expect(qualified.decorators.map((d) => [d.name, d.qualifier, d.boundary])).toEqual([
      ["Controller", "nest", true],
    ])
  })
})

describe("scan — a decorator from a package outside the workspace", () => {
  const SHARED = "@acme/shared"

  it.each([
    ["by name", `import { Controller } from "routing-controllers"`, "Controller"],
    ["renamed on import", `import { Controller as Route } from "routing-controllers"`, "Route"],
    ["by a default import", `import Controller from "routing-controllers"`, "Controller"],
    ["through a namespace import", `import * as tsed from "@tsed/common"`, "tsed.Controller"],
    [
      "through a receiver a default import binds",
      `import tsed from "@tsed/common"`,
      "tsed.Controller",
    ],
  ])(
    "refuses a @Controller imported %s, which is not NestJS's",
    async (_case, importLine, written) => {
      await workspace.writeSource(
        "src/x.controller.ts",
        `${importLine}\n\n@${written}("/x")\nexport class XController {}\n`,
      )

      const controller = symbolNamed(await scanWorkspace(), "XController")
      expect(controller.extKind).toBeNull()
      expect(controller.decorators.map((d) => d.boundary ?? false)).toEqual([false])
    },
  )

  it("still classifies the NestJS decorators beside one it refuses", async () => {
    await workspace.writeSource(
      "src/y.controller.ts",
      [
        `import { Controller, Post } from "@nestjs/common"`,
        `import { Get } from "routing-controllers"`,
        ``,
        `@Controller("/y")`,
        `export class YController {`,
        `  @Get("/a") a() { return null }`,
        `  @Post("/b") b() { return null }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    expect(
      ["YController", "YController.a", "YController.b"].map((name) => {
        const symbol = symbolNamed(result, name)
        return [name, symbol.extKind, symbol.confidence]
      }),
    ).toEqual([
      ["YController", "framework:nestjs:controller", "high"],
      ["YController.a", null, "high"],
      ["YController.b", "framework:nestjs:route", "high"],
    ])
  })

  it.each([
    ["by its name", SHARED],
    ["by a path under it", `${SHARED}/decorators`],
  ])("rates a @Controller from a workspace package, named %s, at medium", async (_case, source) => {
    await workspace.writeSource(
      "src/z.controller.ts",
      `import { Controller } from "${source}"\n\n@Controller("/z")\nexport class ZController {}\n`,
    )

    const result = await scanWith(
      workspace.root,
      { languages: [langTypescriptPlugin], frameworks: [nestjsFrameworkPlugin] },
      {},
      { workspacePackages: [{ name: SHARED, root: "packages/shared" }] },
    )
    const controller = symbolNamed(result, "ZController")
    expect([controller.extKind, controller.confidence]).toEqual([
      "framework:nestjs:controller",
      "medium",
    ])
  })
})

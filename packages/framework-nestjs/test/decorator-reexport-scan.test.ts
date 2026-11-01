import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { nestjsFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("decorator-reexport")

const OWN_CONTROLLER = `export function Controller(path: string) { return (target: object) => target }\n`

const LIBRARIES: Readonly<Record<string, string>> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      paths: { "@app/common": ["libs/common/src/index.ts"], "@app/*": ["libs/*/src"] },
    },
  }),
  "libs/common/src/index.ts": `export { Controller, Get, Injectable } from "@nestjs/common"\n`,
  "libs/layered/src/index.ts": `export { Controller } from "./nest"\n`,
  "libs/layered/src/nest.ts": `export { Controller } from "@nestjs/common"\n`,
  "libs/foreign/src/index.ts": `export { Controller } from "routing-controllers"\n`,
  "libs/star/src/index.ts": `export * from "@nestjs/common"\n`,
  "libs/own/src/index.ts": OWN_CONTROLLER,
  "libs/renamed-first/src/index.ts": `export { Controller as NestController } from "@nestjs/common"\nexport { Controller } from "../../own/src"\n`,
  "libs/renamed-last/src/index.ts": `export { Controller } from "../../own/src"\nexport { Controller as NestController } from "@nestjs/common"\n`,
  "libs/renamed-own/src/index.ts": `export { Controller as NestController } from "@nestjs/common"\n${OWN_CONTROLLER}`,
  "libs/internal/src/index.ts": `import { Controller } from "@nestjs/common"\nexport { Controller } from "../../own/src"\n@Controller("/i") export class Internal {}\n`,
  "libs/internal-star/src/index.ts": `import { Controller } from "@nestjs/common"\nexport * from "routing-controllers"\n@Controller("/i") export class Internal {}\n`,
  "libs/competing-first/src/index.ts": `export { Controller as RcController } from "routing-controllers"\nexport { Controller } from "@nestjs/common"\n`,
  "libs/republished/src/index.ts": `import { Controller } from "@nestjs/common"\nexport { Controller }\n`,
  "libs/default/src/index.ts": `import { Controller } from "@nestjs/common"\nexport default Controller\n`,
  "libs/namespace/src/index.ts": `export * as nest from "@nestjs/common"\n`,
  "src/common.ts": `export { Controller } from "@nestjs/common"\n`,
}

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
  })

describe("scan — a NestJS decorator re-exported through a workspace barrel", () => {
  beforeEach(async () => {
    for (const [path, source] of Object.entries(LIBRARIES)) {
      await workspace.writeSource(path, source)
    }
  })

  it.each([
    [
      "a path alias to a barrel re-exporting @nestjs/common",
      `import { Controller } from "@app/common"`,
      "Controller",
      "high",
    ],
    [
      "the same barrel, the decorator renamed on import",
      `import { Controller as Ctrl } from "@app/common"`,
      "Ctrl",
      "high",
    ],
    [
      "the same barrel through a namespace import",
      `import * as common from "@app/common"`,
      "common.Controller",
      "high",
    ],
    [
      "a wildcard alias to a barrel two re-exports deep",
      `import { Controller } from "@app/layered"`,
      "Controller",
      "high",
    ],
    ["a relative barrel", `import { Controller } from "./common"`, "Controller", "high"],
    [
      "a barrel that re-exports a competing library's decorator under another name first",
      `import { Controller } from "@app/competing-first"`,
      "Controller",
      "high",
    ],
    [
      "a barrel republishing an import of @nestjs/common in an export clause",
      `import { Controller } from "@app/republished"`,
      "Controller",
      "high",
    ],
    [
      "a barrel republishing it as its default export",
      `import Controller from "@app/default"`,
      "Controller",
      "high",
    ],
    [
      "a barrel re-exporting @nestjs/common as a namespace",
      `import { nest } from "@app/namespace"`,
      "nest.Controller",
      "high",
    ],
    [
      "that barrel through a namespace import of its own",
      `import * as lib from "@app/namespace"`,
      "lib.nest.Controller",
      "high",
    ],
    [
      "a barrel re-exporting a competing library",
      `import { Controller } from "@app/foreign"`,
      "Controller",
      "medium",
    ],
    [
      "a barrel reaching @nestjs/common only through export *",
      `import { Controller } from "@app/star"`,
      "Controller",
      "medium",
    ],
    [
      "a barrel declaring its own decorator",
      `import { Controller } from "@app/own"`,
      "Controller",
      "medium",
    ],
    [
      "a barrel re-exporting @nestjs/common's under another name, then its own",
      `import { Controller } from "@app/renamed-first"`,
      "Controller",
      "medium",
    ],
    [
      "a barrel re-exporting its own, then @nestjs/common's under another name",
      `import { Controller } from "@app/renamed-last"`,
      "Controller",
      "medium",
    ],
    [
      "a barrel re-exporting @nestjs/common's under another name beside its own declaration",
      `import { Controller } from "@app/renamed-own"`,
      "Controller",
      "medium",
    ],
    [
      "a barrel that imports @nestjs/common's for its own use and re-exports its own",
      `import { Controller } from "@app/internal"`,
      "Controller",
      "medium",
    ],
    [
      "a barrel that imports @nestjs/common's for its own use and exports * from another library",
      `import { Controller } from "@app/internal-star"`,
      "Controller",
      "medium",
    ],
    [
      "an alias to no file in the workspace",
      `import { Controller } from "@app/missing"`,
      "Controller",
      "medium",
    ],
  ])("rates a controller imported from %s", async (_case, importLine, written, confidence) => {
    await workspace.writeSource(
      "src/x.controller.ts",
      `${importLine}\n\n@${written}("/x")\nexport class XController {}\n`,
    )

    const controller = symbolNamed(await scanWorkspace(), "XController")
    expect([controller.extKind, controller.confidence]).toEqual([
      "framework:nestjs:controller",
      confidence,
    ])
  })

  it("rates a route decorator re-exported through the barrel alongside its controller", async () => {
    await workspace.writeSource(
      "src/y.controller.ts",
      [
        `import { Controller, Get } from "@app/common"`,
        ``,
        `@Controller("/y")`,
        `export class YController {`,
        `  @Get("/list")`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const route = symbolNamed(await scanWorkspace(), "YController.list")
    expect([route.extKind, route.confidence]).toEqual(["framework:nestjs:route", "high"])
  })
})

import { describe, expect, it } from "vitest"
import type { PackageEntryFields } from "../../src/component-manifest"
import { packageEntryPaths } from "../../src/scan/package-entry"

const ROOT = "packages/kit"

function pathsOf(specifier: string, entry?: PackageEntryFields, root = ROOT): string[] {
  return packageEntryPaths(
    { name: "@acme/kit", root, ...(entry === undefined ? {} : { entry }) },
    specifier,
  )
}

describe("the files an import of a workspace package by its name can load", () => {
  it.each<[string, string, PackageEntryFields, string[]]>([
    [
      "`exports` written as one path",
      "@acme/kit",
      { exports: "./src/index.ts" },
      [`${ROOT}/src/index.ts`],
    ],
    [
      "every condition's target, in the order the manifest writes them",
      "@acme/kit",
      {
        exports: {
          ".": {
            source: "./src/index.ts",
            import: { types: "./build/index.d.ts", default: "./build/index.js" },
            require: "./build/index.cjs",
          },
        },
      },
      [
        `${ROOT}/src/index.ts`,
        `${ROOT}/build/index.d.ts`,
        `${ROOT}/build/index.js`,
        `${ROOT}/build/index.cjs`,
      ],
    ],
    [
      "a fallback list",
      "@acme/kit",
      { exports: { ".": ["./src/index.ts", "./index.js"] } },
      [`${ROOT}/src/index.ts`, `${ROOT}/index.js`],
    ],
    [
      "conditions written with no subpath",
      "@acme/kit",
      { exports: { source: "./src/index.ts", default: "./index.js" } },
      [`${ROOT}/src/index.ts`, `${ROOT}/index.js`],
    ],
    [
      "a subpath written out",
      "@acme/kit/mini",
      { exports: { ".": "./src/index.ts", "./mini": { source: "./src/mini/index.ts" } } },
      [`${ROOT}/src/mini/index.ts`],
    ],
    [
      "a subpath pattern, the match put in each target",
      "@acme/kit/lib/sort",
      { exports: { "./lib/*": { source: "./src/lib/*.ts", default: "./lib/*.js" } } },
      [`${ROOT}/src/lib/sort.ts`, `${ROOT}/lib/sort.js`],
    ],
    [
      "the pattern with the longest prefix",
      "@acme/kit/lib/sort",
      { exports: { "./*": "./*.js", "./lib/*": "./src/lib/*.ts" } },
      [`${ROOT}/src/lib/sort.ts`],
    ],
    [
      "the pattern with the longest prefix, written first",
      "@acme/kit/lib/sort",
      { exports: { "./lib/*": "./src/lib/*.ts", "./*": "./*.js" } },
      [`${ROOT}/src/lib/sort.ts`],
    ],
    [
      "the longer of two patterns with one prefix",
      "@acme/kit/lib/sort.js",
      { exports: { "./lib/*": "./src/lib/*", "./lib/*.js": "./src/lib/*.ts" } },
      [`${ROOT}/src/lib/sort.ts`],
    ],
    [
      "the longer of two patterns with one prefix, written first",
      "@acme/kit/lib/sort.js",
      { exports: { "./lib/*.js": "./src/lib/*.ts", "./lib/*": "./src/lib/*" } },
      [`${ROOT}/src/lib/sort.ts`],
    ],
    [
      "an exact subpath ahead of a pattern",
      "@acme/kit/lib/sort",
      { exports: { "./lib/*": "./src/lib/*.ts", "./lib/sort": "./src/sort.ts" } },
      [`${ROOT}/src/sort.ts`],
    ],
    [
      "`main`, `module`, `types` and `typings`, then the package's directory",
      "@acme/kit",
      { typings: "./kit.d.ts", main: "index.js", module: "./esm/index.js", types: "./index.d.ts" },
      [`${ROOT}/index.js`, `${ROOT}/esm/index.js`, `${ROOT}/index.d.ts`, `${ROOT}/kit.d.ts`, ROOT],
    ],
    [
      "`main` past an `exports` of `null`",
      "@acme/kit",
      { exports: null, main: "./index.js" },
      [`${ROOT}/index.js`, ROOT],
    ],
    [
      "a subpath under a package with no `exports`",
      "@acme/kit/utils/sort",
      { main: "index.js" },
      [`${ROOT}/utils/sort`],
    ],
    [
      "the directory alone past a `main` outside the package",
      "@acme/kit",
      { main: "../x.js" },
      [ROOT],
    ],
  ])("reads %s", (_label, specifier, entry, paths) => {
    expect(pathsOf(specifier, entry)).toEqual(paths)
  })

  it("reads the package's directory alone when its manifest names no entry point", () => {
    expect(pathsOf("@acme/kit")).toEqual([ROOT])
  })

  it("reads a package at the workspace root from the root", () => {
    expect(pathsOf("@acme/kit", { exports: "./src/index.ts" }, ".")).toEqual(["src/index.ts"])
    expect(pathsOf("@acme/kit", {}, ".")).toEqual(["."])
  })

  it.each<[string, string, PackageEntryFields]>([
    [
      "a subpath `exports` does not list",
      "@acme/kit/internal",
      { exports: { ".": "./src/index.ts" } },
    ],
    [
      "a subpath `exports` excludes",
      "@acme/kit/private",
      { exports: { "./*": "./src/*.ts", "./private": null } },
    ],
    ["a target outside the package", "@acme/kit", { exports: "./../shared/index.ts" }],
    ["a target that is not relative", "@acme/kit", { exports: { ".": "src/index.ts" } }],
    ["another package's name", "@acme/kit-extra", { exports: "./src/index.ts" }],
    ["a name with no package", "#kit", { exports: "./src/index.ts" }],
  ])("reads nothing for %s", (_label, specifier, entry) => {
    expect(pathsOf(specifier, entry)).toEqual([])
  })
})

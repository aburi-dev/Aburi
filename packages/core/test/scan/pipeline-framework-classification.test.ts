import { componentId, makeCall, relativePath } from "@aburi/test-support"
import type {
  Confidence,
  FileComponent,
  FrameworkPlugin,
  ImportEdge,
  SymbolCandidate,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  extractOneSymbol,
  stubCandidate,
  stubEffectsPlugin,
  stubFrameworkPlugin,
} from "../fixtures/plugins"

function classifying(name: string, extKind: string, derivedBy = `${name}:hit`): FrameworkPlugin {
  return stubFrameworkPlugin(name, { classifySymbol: () => ({ extKind, derivedBy }) })
}

function dropping(name: string, reason = name): FrameworkPlugin {
  return stubFrameworkPlugin(name, { symbolDropHint: () => ({ reason, category: "B" }) })
}

describe("runFilePipeline — framework classification", () => {
  it("takes the first framework's classification and asks no later one", async () => {
    const asked: string[] = []
    const second = stubFrameworkPlugin("framework-second", {
      classifySymbol: () => {
        asked.push("framework-second")
        return { extKind: "framework:second:role", derivedBy: "framework-second:hit" }
      },
    })

    const { symbols } = await extractOneSymbol({
      frameworks: [classifying("framework-first", "framework:first:role"), second],
    })

    expect(symbols[0]?.extKind).toBe("framework:first:role")
    expect(symbols[0]?.derivedBy).toEqual(["framework-first:hit"])
    expect(asked).toEqual([])
  })

  it("falls through a framework that classifies nothing to the next", async () => {
    const { symbols } = await extractOneSymbol({
      frameworks: [
        stubFrameworkPlugin("framework-null"),
        classifying("framework-hit", "framework:hit:role"),
      ],
    })
    expect(symbols[0]?.extKind).toBe("framework:hit:role")
  })

  it("hands the classifier the file's import edges", async () => {
    const seen: (readonly ImportEdge[])[] = []
    const watching = stubFrameworkPlugin("framework-imports", {
      classifySymbol: (_symbol, ctx) => {
        seen.push(ctx.imports)
        return null
      },
    })
    const imports: ImportEdge[] = [
      { source: "@nestjs/common", symbols: ["Controller as Ctrl"], line: 1, dynamic: false },
    ]

    const result = await extractOneSymbol({ frameworks: [watching], imports })

    // The very array, not a copy: a plugin may memoize per file on its identity.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(result.imports)
  })

  it("marks the decorator the winning classification names as a boundary", async () => {
    const candidate = stubCandidate("Fn", {
      decorators: [
        { name: "Controller", raw: "@Controller()", arguments: [], boundary: false, line: 1 },
        { name: "Injectable", raw: "@Injectable()", arguments: [], boundary: false, line: 2 },
      ],
    })
    const framework = stubFrameworkPlugin("framework-boundary", {
      classifySymbol: () => ({
        extKind: "framework:hit:controller",
        decoratorBoundaries: { Controller: true },
        derivedBy: "framework-boundary:hit",
      }),
    })

    const { symbols } = await extractOneSymbol({ candidate, frameworks: [framework] })

    expect(symbols[0]?.decorators.map((d) => [d.name, d.boundary])).toEqual([
      ["Controller", true],
      ["Injectable", false],
    ])
  })

  it("splits a `;`-joined derivedBy into entries, without repeating one the candidate has", async () => {
    const candidate = stubCandidate("Fn", { derivedBy: ["framework:next:page"] })
    const framework = classifying(
      "framework-compound",
      "framework:next:page",
      "framework:next:page;framework:next:client-component",
    )

    const { symbols } = await extractOneSymbol({ candidate, frameworks: [framework] })

    expect(symbols[0]?.derivedBy).toEqual([
      "framework:next:page",
      "framework:next:client-component",
    ])
  })

  it("records the middleware the winning classification names, normalized and without empty names", async () => {
    const framework = stubFrameworkPlugin("framework-route", {
      classifySymbol: () => ({
        extKind: "framework:express:route",
        derivedBy: "framework-route:hit",
        middleware: ["requireAdmin", "", "caf\u0065\u0301", ' requireRole("a \n  b") ', " \t "],
      }),
    })

    const { symbols } = await extractOneSymbol({ frameworks: [framework] })

    expect(symbols[0]?.middleware).toEqual(["requireAdmin", "caf\u00e9", 'requireRole("a b")'])
  })

  it.each<[string, string[] | undefined]>([
    ["names none", undefined],
    ["names an empty list", []],
    ["names only empty names", ["", "  "]],
  ])("leaves the middleware out when the classification %s", async (_label, middleware) => {
    const framework = stubFrameworkPlugin("framework-route", {
      classifySymbol: () => ({
        extKind: "framework:express:route",
        derivedBy: "framework-route:hit",
        ...(middleware === undefined ? {} : { middleware }),
      }),
    })

    const { symbols } = await extractOneSymbol({ frameworks: [framework] })

    expect(symbols[0]).not.toHaveProperty("middleware")
  })

  it("adds the winning classification's calls by line, after the body's on a shared line, in NFC and without blank targets", async () => {
    const framework = stubFrameworkPlugin("framework-procedure", {
      classifySymbol: () => ({
        extKind: "framework:trpc:procedure",
        derivedBy: "framework-procedure:hit",
        calls: [
          { target: "protectedProcedure", line: 2 },
          { target: "", line: 3 },
          { target: "  ", line: 3 },
          { target: "caf\u0065\u0301", line: 1 },
        ],
      }),
    })
    const body = {
      rules: [],
      calls: [makeCall({ target: "protectedProcedure.mutation", line: 2 })],
    }

    const { symbols } = await extractOneSymbol({ frameworks: [framework], body })

    expect(symbols[0]?.calls).toEqual([
      { target: "caf\u00e9", line: 1, resolved: null },
      { target: "protectedProcedure.mutation", line: 2, resolved: null },
      { target: "protectedProcedure", line: 2, resolved: null },
    ])
  })

  it("keeps the added calls as calls, past the Category C drop and every effect plugin", async () => {
    const framework = stubFrameworkPlugin("framework-procedure", {
      classifySymbol: () => ({
        extKind: "framework:trpc:procedure",
        derivedBy: "framework-procedure:hit",
        calls: [
          { target: "console.log", line: 1 },
          { target: "prisma.user.findMany", line: 2 },
        ],
      }),
    })
    const classifiesEverything = stubEffectsPlugin("effects-everything", () => ({
      effectId: "db.read",
      confidence: "high",
      derivedBy: "effects-everything:any",
    }))

    const { symbols } = await extractOneSymbol({
      frameworks: [framework],
      effects: [classifiesEverything],
    })

    expect(symbols[0]?.calls.map((call) => call.target)).toEqual([
      "console.log",
      "prisma.user.findMany",
    ])
    expect(symbols[0]?.effects).toEqual([])
  })

  it.each<[string, readonly FrameworkPlugin[], Confidence]>([
    [
      "the winning classifier's confidence",
      [
        stubFrameworkPlugin("framework-medium", {
          classifySymbol: () => ({
            extKind: "framework:express:middleware",
            derivedBy: "framework-medium:hit",
            confidence: "medium",
          }),
        }),
      ],
      "medium",
    ],
    ["high when no framework classifies", [], "high"],
    [
      "high when the winning classifier states none",
      [classifying("framework-silent", "framework:nestjs:controller")],
      "high",
    ],
  ])("gives the Symbol %s", async (_label, frameworks, confidence) => {
    const { symbols } = await extractOneSymbol({ frameworks })
    expect(symbols[0]?.confidence).toBe(confidence)
  })
})

function providing(name: string, frameworks: readonly string[]): FrameworkPlugin {
  const plugin = stubFrameworkPlugin(name, {
    classifySymbol: () => ({ extKind: `framework:${name}:role`, derivedBy: `${name}:hit` }),
    symbolDropHint: () => ({ reason: name, category: "B" }),
  })
  const { provides } = plugin.manifest
  return {
    ...plugin,
    manifest: { ...plugin.manifest, provides: { ...provides, frameworks: [...frameworks] } },
  }
}

function inComponent(frameworks: readonly string[]): FileComponent {
  return { id: componentId("api"), root: relativePath("apps/api"), frameworks }
}

describe("runFilePipeline — the frameworks of the file's Component", () => {
  it.each<[string, readonly string[], FileComponent | null, boolean]>([
    ["a file no Component holds", ["react"], null, true],
    ["a Component recording no framework", ["react"], inComponent([]), true],
    [
      "a Component recording the plugin's framework",
      ["react"],
      inComponent(["express", "react"]),
      true,
    ],
    [
      "a Component naming the plugin itself",
      ["react"],
      inComponent(["express", "react-plugin"]),
      true,
    ],
    ["a Component recording only another framework", ["react"], inComponent(["express"]), false],
    ["a plugin providing no framework", [], inComponent(["express"]), true],
    [
      "a plugin providing a framework detection never records",
      ["acme"],
      inComponent(["express"]),
      true,
    ],
    [
      "a plugin providing one framework detection records and one it never does",
      ["react", "acme"],
      inComponent(["express"]),
      true,
    ],
  ])("for %s, the plugin classifies and drops: %s", async (_case, frameworks, component, runs) => {
    const { symbols } = await extractOneSymbol({
      frameworks: [providing("react-plugin", frameworks)],
      component,
    })
    expect(symbols[0]?.extKind ?? null).toBe(runs ? "framework:react-plugin:role" : null)
    expect(symbols[0]?.dropped).toBe(runs)
  })

  it("passes a ruled-out plugin by for the next one, and hands each the file's Component", async () => {
    const seen: (FileComponent | null)[] = []
    const express = stubFrameworkPlugin("express-plugin", {
      classifySymbol: (_symbol, ctx) => {
        seen.push(ctx.component)
        return { extKind: "framework:express:role", derivedBy: "express-plugin:hit" }
      },
    })
    const component = inComponent(["express"])
    const { symbols } = await extractOneSymbol({
      frameworks: [providing("react-plugin", ["react"]), express],
      component,
    })
    expect(symbols[0]?.extKind).toBe("framework:express:role")
    expect(seen).toEqual([component])
  })
})

describe("runFilePipeline — drop decisions", () => {
  it("asks a framework that did not classify the Symbol, and shows it the winning classification", async () => {
    const seen: (string | null)[] = []
    const dropper = stubFrameworkPlugin("framework-dropper", {
      symbolDropHint: (symbol) => {
        seen.push(symbol.extKind)
        return { reason: "dropper says so", category: "B" }
      },
    })

    const { symbols } = await extractOneSymbol({
      frameworks: [classifying("framework-classifier", "framework:first:role"), dropper],
    })

    expect(seen).toEqual(["framework:first:role"])
    expect(symbols[0]?.dropped).toBe(true)
    expect(symbols[0]?.dropReason).toBe("dropper says so")
  })

  it("keeps no middleware and no added call on a dropped Symbol, as it keeps no rules", async () => {
    const framework = stubFrameworkPlugin("framework-route", {
      classifySymbol: () => ({
        extKind: "framework:express:route",
        derivedBy: "framework-route:hit",
        middleware: ["requireAdmin"],
        calls: [{ target: "requireAdmin", line: 1 }],
      }),
      symbolDropHint: () => ({ reason: "generated", category: "B" }),
    })

    const { symbols } = await extractOneSymbol({ frameworks: [framework] })

    expect(symbols[0]?.dropped).toBe(true)
    expect(symbols[0]).not.toHaveProperty("middleware")
    expect(symbols[0]?.calls).toEqual([])
  })

  it.each<[string, SymbolCandidate, readonly FrameworkPlugin[], string | null]>([
    [
      "the core shape rules ahead of every plugin",
      stubCandidate("Shape", { kind: "interface" }),
      [dropping("framework-a")],
      "interface (data model)",
    ],
    [
      "the first framework, in list order",
      stubCandidate("Fn"),
      [dropping("framework-a"), dropping("framework-b")],
      "framework-a",
    ],
    [
      "a framework ahead of the language plugin",
      stubCandidate("Fn"),
      [dropping("framework-a")],
      "framework-a",
    ],
    [
      "the language plugin when no framework drops it",
      stubCandidate("Fn"),
      [stubFrameworkPlugin()],
      "language",
    ],
  ])("takes the drop reason from %s", async (_label, candidate, frameworks, reason) => {
    const { symbols } = await extractOneSymbol({
      candidate,
      frameworks,
      language: { symbolDropHint: () => ({ reason: "language", category: "B" }) },
    })
    expect(symbols[0]?.dropReason).toBe(reason)
  })

  it("keeps the Symbol when no rule and no plugin drops it", async () => {
    const keeping = stubFrameworkPlugin("framework-keeps", { symbolDropHint: () => null })
    const { symbols } = await extractOneSymbol({ frameworks: [keeping] })
    expect(symbols[0]?.dropped).toBe(false)
    expect(symbols[0]?.dropReason).toBeNull()
  })
})

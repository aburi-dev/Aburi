import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { DEFAULT_WORK_DIR } from "../args.mjs"
import {
  callSiteKey,
  callSitesOf,
  censusRepos,
  drawIndices,
  foreignPluginRefs,
  isTestPath,
  parseCensusArgs,
  prepareCommand,
  renderCheck,
  renderResolution,
  renderShares,
  scanFaults,
  settles,
  stratifiedShare,
  wilsonInterval,
} from "../census-report.mjs"

const HEAD = "0".repeat(40)
const CALLER = "ts:src/a.ts#f"
const TARGET = "ts:src/b.ts#g"

function repo(id, noMatch) {
  return { id, head: HEAD, calls: 1000, resolved: 100, unresolved: { noMatch } }
}

function sample(overrides = {}) {
  return {
    repo: "a",
    file: "src/a.ts",
    line: 1,
    symbol: CALLER,
    target: "g",
    test: false,
    category: "rule",
    expected: "external",
    expectedSymbol: null,
    note: null,
    ...overrides,
  }
}

function edge(overrides = {}) {
  return sample({ expected: "edge", expectedSymbol: TARGET, ...overrides })
}

function census(samples, repos = [repo("a", 100)]) {
  return {
    repos,
    categories: {
      rule: { needsTypes: false, definition: "", rule: "" },
      typed: { needsTypes: true, definition: "", rule: null },
    },
    samples,
  }
}

/** The cells after the label of the row it starts, in the `table`-th table of `markdown`. */
function rowOf(markdown, table, label) {
  return markdown
    .split("\n\n")
    [table].split("\n")
    .find((line) => line.startsWith(`| ${label} |`))
    ?.slice(2, -2)
    .split(" | ")
    .slice(1)
}

describe("parseCensusArgs", () => {
  it.each([
    [[], /first argument is the mode/],
    [["sample"], /first argument is the mode/],
    [["shares", "--work-dir", "/tmp/w"], /Unknown flag for `shares`/],
    [["check", "--seed", "x"], /Unknown flag for `check`/],
    [["draw", "--per-repo", "0"], /at least 1/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseCensusArgs(argv)).toThrow(message)
  })

  it("reads the draw's flags and resolves the work directory", () => {
    const options = parseCensusArgs([
      "draw",
      "--only",
      "zod,nest",
      "--per-repo",
      "20",
      "--seed",
      "s",
      "--work-dir",
      "/tmp/w",
    ])
    expect(options).toMatchObject({
      mode: "draw",
      only: ["zod", "nest"],
      perRepo: 20,
      seed: "s",
      workDir: resolve("/tmp/w"),
    })
  })
})

describe("prepareCommand", () => {
  const run = "node benchmarks/public-repos/run.mjs --only zod --runs 1 --warmup 0 --no-diff"

  it.each([
    ["the default work directory", DEFAULT_WORK_DIR, run],
    ["another one", resolve("/w/clones"), `${run} --work-dir ${resolve("/w/clones")}`],
    [
      "one with a space",
      resolve("/w/my clones"),
      `${run} --work-dir ${JSON.stringify(resolve("/w/my clones"))}`,
    ],
  ])("prepares the clone in %s", (_case, workDir, command) => {
    expect(prepareCommand("zod", workDir)).toBe(command)
  })
})

describe("censusRepos", () => {
  const sampled = census([sample()])

  it("gives the pins of the repositories the census sampled", () => {
    const manifest = {
      repos: [
        { id: "b", head: HEAD },
        { id: "a", head: HEAD, url: "u" },
      ],
    }
    expect(censusRepos(manifest, sampled)).toEqual([{ id: "a", head: HEAD, url: "u" }])
  })

  it.each([
    ["a repository repos.json no longer pins", [], /samples a, which repos.json no longer pins/],
    ["a pin that moved", [{ id: "a", head: "1".repeat(40) }], /not comparable across pins/],
  ])("refuses %s", (_case, repos, message) => {
    expect(() => censusRepos({ repos }, sampled)).toThrow(message)
  })
})

describe("foreignPluginRefs", () => {
  const root = resolve("/work/aburi")
  const built = (checkout, name) =>
    pathToFileURL(resolve(checkout, "packages", name, "dist/index.mjs")).href

  it("names every plugin ref that does not load from the checkout's own builds", () => {
    const elsewhere = built(resolve("/work/aburi-main"), "framework-next")
    const config = {
      languages: [built(root, "lang-typescript")],
      frameworks: [elsewhere, "@aburi/framework-react"],
      effects: [built(root, "effects-node")],
      components: [],
    }
    expect(foreignPluginRefs(config, root)).toEqual([elsewhere, "@aburi/framework-react"])
  })
})

describe("scanFaults", () => {
  const whole = {
    skipped: [],
    extractionFailures: [],
    unrepresentableFiles: [],
    coverageFault: null,
  }
  const skip = (index) => ({ path: `src/${index}.ts`, reason: "parse-timeout" })

  it("finds none in a whole scan", () => {
    expect(scanFaults(whole)).toEqual([])
  })

  it.each([
    ["a skipped file", { skipped: [skip(1)] }, "1 file(s) skipped: src/1.ts (parse-timeout)"],
    [
      "more skipped files than it lists",
      { skipped: [1, 2, 3, 4, 5].map(skip) },
      "5 file(s) skipped: src/1.ts (parse-timeout), src/2.ts (parse-timeout), src/3.ts (parse-timeout) and 2 more",
    ],
    [
      "an extraction failure",
      { extractionFailures: [{ file: "src/a.ts", message: "m" }] },
      "1 extraction failure(s)",
    ],
    [
      "a file no Symbol id can name",
      { unrepresentableFiles: [{ fsPath: "/w/a:b.ts", reason: "unspellable-name" }] },
      "1 file(s) no Symbol id can name",
    ],
    [
      "a coverage fault",
      { coverageFault: { kind: "nothing-discovered" } },
      "coverage fault: nothing-discovered",
    ],
  ])("names %s", (_case, fault, named) => {
    expect(scanFaults({ ...whole, ...fault })).toEqual([named])
  })
})

describe("drawIndices", () => {
  it.each([
    ["no-match:zod", [7, 16, 44, 49, 63, 69, 86, 91]],
    ["ä𝒵:seed", [18, 36, 45, 46, 48, 59, 92, 94]],
  ])("draws the indices %j names, on every platform", (seed, indices) => {
    expect(drawIndices(100, 8, seed)).toEqual(indices)
  })

  it("draws without replacement, in index order, inside the population", () => {
    const drawn = drawIndices(80, 75, "seed")
    expect(new Set(drawn).size).toBe(75)
    expect(drawn).toEqual([...drawn].sort((a, b) => a - b))
    expect(drawn.every((index) => index >= 0 && index < 80)).toBe(true)
  })

  it("takes the whole population when it is smaller than the sample", () => {
    expect(drawIndices(3, 75, "seed")).toEqual([0, 1, 2])
  })
})

describe("isTestPath", () => {
  it.each([
    ["src/router/common.case.test.ts", true],
    ["packages/zod/src/v3/tests/Mocker.ts", true],
    ["src/__tests__/server.ts", true],
    ["integration/hello-world/e2e/middleware.spec.ts", true],
    ["packages/bench/compile.bench.ts", true],
    ["src/types.test-d.ts", true],
    ["src/testing/index.ts", false],
    ["src/contest.ts", false],
    ["src/router/linear-router/router.ts", false],
  ])("reads %s as a test file: %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected)
  })
})

describe("wilsonInterval", () => {
  it("keeps an interval around a share at either end of the scale", () => {
    expect(wilsonInterval(0, 75).low).toBeCloseTo(0, 10)
    expect(wilsonInterval(0, 75).high).toBeCloseTo(0.0487, 4)
    expect(wilsonInterval(75, 75).high).toBeCloseTo(1, 10)
    expect(wilsonInterval(75, 75).low).toBeCloseTo(0.9513, 4)
  })

  it("is about eleven points either side of an even split", () => {
    const { low, high } = wilsonInterval(37, 74)
    expect(low).toBeCloseTo(0.3889, 4)
    expect(high).toBeCloseTo(0.6111, 4)
  })
})

describe("stratifiedShare", () => {
  it("weights each repository by its population", () => {
    const { share } = stratifiedShare([
      { population: 300, n: 10, hits: 10 },
      { population: 100, n: 10, hits: 0 },
    ])
    expect(share).toBeCloseTo(0.75, 10)
  })

  it("has no margin when every stratum was sampled whole", () => {
    const { margin } = stratifiedShare([
      { population: 10, n: 10, hits: 5 },
      { population: 20, n: 20, hits: 4 },
    ])
    expect(margin).toBe(0)
  })

  it("narrows as the sample takes more of a finite population", () => {
    const margin = (population) => stratifiedShare([{ population, n: 75, hits: 37 }]).margin
    expect(margin(100)).toBeLessThan(margin(3000))
    expect(margin(3000)).toBeCloseTo(0.1117, 3)
  })
})

describe("renderShares", () => {
  it.each([
    ["a category it does not define", census([sample({ category: "x" })]), /does not define: x/],
    [
      "an expected outcome it does not know",
      census([sample({ expected: "resolved" })]),
      /no expected outcome/,
    ],
    [
      "a sample without an expected outcome",
      census([sample({ expected: null })]),
      /no expected outcome/,
    ],
    [
      "an `edge` sample without its Symbol",
      census([edge({ expectedSymbol: null })]),
      /without the Symbol/,
    ],
    [
      "a Symbol on a sample that expects no edge",
      census([sample({ expectedSymbol: TARGET })]),
      /expect no edge/,
    ],
    ["a repository without a baseline", census([sample({ repo: "b" })]), /no baseline for: b/],
    [
      "a repository it samples none of",
      census([sample()], [repo("a", 100), repo("b", 100)]),
      /baseline for b but samples none of its calls/,
    ],
    [
      "more samples than the repository's `no-match` holds",
      census([sample(), sample({ line: 2 })], [repo("a", 1)]),
      /samples 2 calls of a/,
    ],
  ])("refuses %s", (_case, input, message) => {
    expect(() => renderShares(input)).toThrow(message)
  })

  it("counts the gap, its edges, and what needs types, per repository and weighted by no-match", () => {
    const shares = renderShares(
      census(
        [
          sample({ repo: "a" }),
          edge({ repo: "a" }),
          sample({ repo: "a", category: "typed" }),
          edge({ repo: "a", category: "typed" }),
          sample({ repo: "b", expected: "local-scope" }),
          sample({ repo: "b", category: "typed", test: true }),
        ],
        [repo("a", 300), repo("b", 100)],
      ),
    )

    expect(rowOf(shares, 0, "`rule`")).toEqual(["no", "2", "1", "3"])
    expect(rowOf(shares, 1, "`rule`")).toEqual(["1", "1", "1", "0", "0"])
    expect(rowOf(shares, 1, "`typed`")).toEqual(["1", "2", "0", "0", "0"])
    expect(rowOf(shares, 2, "Resolver gap: a rule without types settles it")).toEqual([
      expect.stringMatching(/^50% /),
      expect.stringMatching(/^50% /),
      "50.0% ± 40.4%",
    ])
    expect(rowOf(shares, 2, "…and the rule yields a call edge")?.[0]).toMatch(/^25% /)
    expect(rowOf(shares, 2, "…and types yield a call edge")?.[2]).toMatch(/^18\.8% /)
    expect(rowOf(shares, 3, "Test files")).toEqual(["1", "0 (0%)", "1 (100%)"])
    expect(rowOf(shares, 3, "Other files")).toEqual(["5", "3 (60%)", "2 (40%)"])
  })
})

describe("callSitesOf", () => {
  it("joins each call site with the bucket of its diagnostic, the first call of a repeated site standing", () => {
    const ir = {
      symbols: [
        {
          id: CALLER,
          calls: [
            { line: 1, target: "g", resolved: TARGET },
            { line: 2, target: "h", resolved: null },
            { line: 2, target: "h", resolved: "ts:src/b.ts#h" },
          ],
        },
        { id: "ts:src/a.ts#T", calls: [] },
      ],
    }
    const unresolved = [
      { symbolId: CALLER, line: 2, target: "h", bucket: "external" },
      { symbolId: CALLER, line: 2, target: "h", bucket: "dynamic" },
      { symbolId: "ts:src/a.ts#removed", line: 9, target: "x", bucket: "no-match" },
    ]

    expect([...callSitesOf(ir, unresolved)]).toEqual([
      [callSiteKey({ symbol: CALLER, line: 1, target: "g" }), { resolved: TARGET, bucket: null }],
      [
        callSiteKey({ symbol: CALLER, line: 2, target: "h" }),
        { resolved: null, bucket: "external" },
      ],
    ])
  })
})

describe("settles", () => {
  it.each([
    ["edge", "resolved", TARGET, true],
    ["edge", "resolved", "ts:src/c.ts#g", false],
    ["external", "external", null, true],
    ["local-scope", "local-scope", null, true],
    ["dynamic", "dynamic", null, true],
    ["untyped", "no-match", null, true],
    ["local-scope", "no-match", null, false],
  ])("takes a call expected as %s that lands in %s (%s) as settled: %s", (expected, outcome, resolved, settled) => {
    const expectedSymbol = expected === "edge" ? TARGET : null
    expect(settles(sample({ expected, expectedSymbol }), { outcome, resolved })).toBe(settled)
  })
})

describe("renderCheck", () => {
  const ir = (...calls) => ({ symbols: [{ id: CALLER, calls }] })
  const diagnostic = (line, bucket) => ({ symbolId: CALLER, line, target: "g", bucket })

  it("files each sampled call by where it lands now, and counts the ones settled as expected", () => {
    const resolved = edge({ line: 1 })
    const moved = sample({ line: 2 })
    const bucketed = sample({ line: 3 })
    const untyped = sample({ line: 4, category: "typed", expected: "untyped" })
    const elsewhere = edge({ line: 5 })
    const sites = callSitesOf(
      ir(
        { line: 1, target: "g", resolved: TARGET },
        { line: 3, target: "g", resolved: null },
        { line: 4, target: "g", resolved: null },
        { line: 5, target: "g", resolved: "ts:src/c.ts#g" },
      ),
      [diagnostic(3, "external"), diagnostic(4, "no-match")],
    )

    const table = renderCheck(
      census([resolved, moved, bucketed, untyped, elsewhere]),
      new Map([["a", sites]]),
    )

    expect(rowOf(table, 0, "`rule`")).toEqual(["no", "0", "2", "0", "1", "0", "0", "1", "2 / 4"])
    expect(rowOf(table, 0, "`typed`")).toEqual(["yes", "1", "0", "0", "0", "0", "0", "0", "1 / 1"])
  })

  it.each([
    ["no bucket", [], /lands in null/],
    ["a bucket it does not count", [diagnostic(1, "later")], /lands in "later"/],
  ])("refuses a call that lands in %s", (_case, diagnostics, message) => {
    const sites = callSitesOf(ir({ line: 1, target: "g", resolved: null }), diagnostics)
    expect(() => renderCheck(census([sample()]), new Map([["a", sites]]))).toThrow(message)
  })
})

describe("renderResolution", () => {
  it("sets each repository's resolved calls at the draw beside those of the scan now", () => {
    const entry = (resolved) => ({ id: "zod", calls: 1000, resolved })
    expect(renderResolution([{ recorded: entry(290), now: entry(301) }]).split("\n")).toEqual([
      "| Repo | Resolved then | Resolved now |",
      "|---|---:|---:|",
      "| `zod` | 290 / 1000 (29.0%) | 301 / 1000 (30.1%) |",
      "",
    ])
  })
})

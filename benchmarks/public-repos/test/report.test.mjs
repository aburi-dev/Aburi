import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  comparedFields,
  countRecoverableParseErrors,
  parseArgs,
  previousResultFor,
  readSweep,
  renderReport,
  reproducesPrevious,
  scanRunFault,
  scanSchedule,
  scrubPaths,
  summariseScans,
} from "../report.mjs"

function measurement(overrides = {}) {
  return { wallMs: 1000, maxRssKb: 120_000, exitCode: 0, failure: null, ...overrides }
}

function run(overrides = {}) {
  return {
    irWritten: true,
    hash: "a",
    ...overrides,
    measurement: measurement(overrides.measurement),
  }
}

const REPO = { id: "zod", head: "h1", base: "b1" }

const PREVIOUS_RUN = {
  startedAt: "2000-01-01T00:00:00.000Z",
  commit: "aaaaaaaa0000",
  dirty: false,
  environment: { node: "v24.0.0", cpus: 4, cpuModel: "CPU-A", totalMemGiB: 16 },
}

const BASELINE = { commit: "aaaaaaaa0000", dirty: false }
const UNBUILT_BASELINE = { commit: "aaaaaaaa0000", failed: "build" }

function measured(id, overrides = {}) {
  return {
    id,
    head: "h1",
    base: "b1",
    scan: {
      wallMsMedian: 2390,
      peakRssKb: 120_000,
      exitCode: 0,
      irHashes: ["x", "x"],
      warnings: "",
    },
    metrics: { totalCalls: 0, skippedByReason: {} },
    diff: {
      wallMs: 5400,
      peakRssKb: 150_000,
      exitCode: 0,
      summary: { added: 1, removed: 0, changed: 2, moved: 0 },
    },
    ...overrides,
  }
}

function sweep(extra, ...results) {
  return {
    startedAt: "2000-02-01T00:00:00.000Z",
    generator: "0.6.0",
    commit: "bbbbbbbb0000",
    dirty: false,
    options: { runs: 3, warmup: 1, diff: true },
    environment: { node: "v24.1.0", cpus: 4, cpuModel: "CPU-B", totalMemGiB: 16 },
    ...extra,
    results,
  }
}

describe("summariseScans", () => {
  it("condemns the whole repository when any measured run failed, keeping what it printed", () => {
    const summary = summariseScans(
      [run(), run({ measurement: { exitCode: 1 }, irWritten: false }), run()],
      { warnings: "⚠ out of heap" },
    )
    expect(summary).toEqual({
      failed: "scan",
      fault: "run 2 of 3: exit 1",
      warnings: "⚠ out of heap",
    })
  })

  it("keeps a gate exit, which is a completed run, as a measurement", () => {
    const summary = summariseScans([run({ measurement: { exitCode: 3 } })])
    expect(summary.failed).toBeUndefined()
    expect(summary.exitCode).toBe(3)
  })

  it("keeps every run's exit code and hash, not only one", () => {
    const summary = summariseScans([
      run({ measurement: { exitCode: 0 } }),
      run({ measurement: { exitCode: 3 }, hash: "b" }),
      run({ measurement: { exitCode: 0 } }),
    ])
    expect(summary.exitCodes).toEqual([0, 3, 0])
    expect(summary.irHashes).toEqual(["a", "b", "a"])
    expect(summary.deterministic).toBe(false)
  })

  it("leaves determinism unmeasured when a single run compared nothing", () => {
    expect(summariseScans([run()]).deterministic).toBeNull()
    expect(summariseScans([run(), run()]).deterministic).toBe(true)
    expect(summariseScans([run(), run({ hash: "b" })]).deterministic).toBe(false)
  })
})

describe("scanRunFault", () => {
  it("accepts a clean run, and a gate exit that still wrote an IR", () => {
    expect(scanRunFault(measurement(), true)).toBeNull()
    expect(scanRunFault(measurement({ exitCode: 3 }), true)).toBeNull()
  })

  it("rejects a run with no measurement, a runtime or input failure, and a missing IR", () => {
    expect(scanRunFault(measurement({ wallMs: null, failure: "killed" }), true)).toBe("killed")
    expect(scanRunFault(measurement({ exitCode: 1 }), true)).toBe("exit 1")
    expect(scanRunFault(measurement({ exitCode: 2 }), true)).toBe("exit 2")
    expect(scanRunFault(measurement(), false)).toBe("no IR was written")
  })
})

describe("scrubPaths", () => {
  it("removes the work directory and the base worktree from captured output", () => {
    const text =
      "⚠ Config /tmp/bench/zod/aburi.json sits below the workspace root /tmp/aburi-worktree-QBe6m9/base."
    expect(scrubPaths(text, "/tmp/bench")).toBe(
      "⚠ Config <work-dir>/zod/aburi.json sits below the workspace root <base-worktree>/base.",
    )
  })

  it("leaves output that names no absolute path alone", () => {
    expect(scrubPaths("⚠ 115 file(s) had recoverable parse errors.", "/tmp/bench")).toBe(
      "⚠ 115 file(s) had recoverable parse errors.",
    )
  })
})

describe("countRecoverableParseErrors", () => {
  it("reads the count the scan reported", () => {
    expect(countRecoverableParseErrors("⚠ 115 file(s) had recoverable parse errors.\n")).toBe(115)
  })

  it("is zero when the scan reported none", () => {
    expect(countRecoverableParseErrors("")).toBe(0)
    expect(countRecoverableParseErrors("⚠ 1 file(s) contributed no Symbols.\n")).toBe(0)
  })
})

describe("parseArgs", () => {
  it("rejects a run count that is not a positive whole number", () => {
    expect(() => parseArgs(["--runs", "abc"])).toThrow(/--runs/)
    expect(() => parseArgs(["--runs", "0"])).toThrow(/--runs/)
    expect(() => parseArgs(["--runs", "2.5"])).toThrow(/--runs/)
    expect(() => parseArgs(["--warmup", "-1"])).toThrow(/--warmup/)
  })

  it.each(["--only", "--work-dir", "--baseline", "--previous", "--baseline-failed"])(
    "rejects %s without a value, naming it",
    (flag) => {
      expect(() => parseArgs([flag])).toThrow(new RegExp(`^${flag} needs a value`))
    },
  )

  it("accepts the defaults and the flags the README documents", () => {
    expect(parseArgs([])).toMatchObject({
      runs: 3,
      diff: true,
      only: null,
      baseline: null,
      baselineFailed: null,
      previous: null,
    })
    expect(parseArgs(["--no-diff"]).diff).toBe(false)
    expect(parseArgs(["--only", "zod,nest"]).only).toEqual(["zod", "nest"])
    expect(parseArgs(["--baseline-failed", "aaaaaaaa0000"]).baselineFailed).toBe("aaaaaaaa0000")
  })

  it("resolves the baseline checkout and the previous results file it is given", () => {
    expect(parseArgs(["--baseline", "prev", "--previous", "results/prev.json"])).toMatchObject({
      baseline: resolve("prev"),
      previous: resolve("results/prev.json"),
    })
  })

  it("refuses a baseline that is both given and said to have failed to build", () => {
    expect(() => parseArgs(["--baseline", "prev", "--baseline-failed", "aaaaaaaa0000"])).toThrow(
      /--baseline and --baseline-failed/,
    )
  })
})

describe("readSweep", () => {
  it("reads a sweep's results file, failed repositories included", () => {
    const previous = sweep({}, measured("zod"), { id: "nest", failed: "init", fault: "exit 2" })
    expect(readSweep(JSON.stringify(previous), "prev.json")).toEqual(previous)
  })

  it.each([
    ["text that is not JSON", "{", /^--previous prev\.json is not JSON: /],
    [
      "a file with no results",
      JSON.stringify({ ...sweep({}), results: undefined }),
      /^--previous prev\.json is not a sweep's results file: it has no results\.$/,
    ],
    [
      "a file with no start or environment",
      JSON.stringify({ results: [] }),
      /: it has no startedAt, environment\.$/,
    ],
    [
      "a measured result with no scan",
      JSON.stringify(sweep({}, { id: "zod", head: "h1" })),
      /: results\[0\] needs an id, and a head and a scan unless it failed\.$/,
    ],
    [
      "a result with no id",
      JSON.stringify(sweep({}, measured("zod"), { failed: "init" })),
      /: results\[1\] needs an id/,
    ],
  ])("refuses %s", (_, text, message) => {
    expect(() => readSweep(text, "prev.json")).toThrow(message)
  })
})

describe("previousResultFor", () => {
  it("takes the previous sweep's numbers and hashes for the repository at the same pins", () => {
    expect(previousResultFor(sweep({}, measured("zod")), REPO)).toEqual({
      scanWallMsMedian: 2390,
      diff: { wallMs: 5400, exitCode: 0 },
      irHashes: ["x", "x"],
    })
  })

  it.each([
    ["a sweep recorded before every hash was kept by its one hash", { irHash: "x" }, ["x"]],
    ["a sweep that kept no hash as none", {}, []],
  ])("reads %s", (_, hashes, irHashes) => {
    const earlier = measured("zod", { scan: { wallMsMedian: 2390, ...hashes } })
    expect(previousResultFor(sweep({}, earlier), REPO)?.irHashes).toEqual(irHashes)
  })

  it.each([
    ["no previous sweep", null],
    ["a sweep that left the repository out", sweep({}, measured("nest"))],
    ["a sweep where it failed", sweep({}, measured("zod", { failed: "scan" }))],
    ["a sweep at another head", sweep({}, measured("zod", { head: "h0" }))],
  ])("has nothing to compare with %s", (_, previous) => {
    expect(previousResultFor(previous, REPO)).toBeNull()
  })

  it("compares the scan but not the diff across another base", () => {
    expect(previousResultFor(sweep({}, measured("zod", { base: "b0" })), REPO)).toMatchObject({
      scanWallMsMedian: 2390,
      diff: null,
    })
  })
})

describe("reproducesPrevious", () => {
  const previous = { irHashes: ["x", "x", "x"] }

  it("holds when every run wrote the IR the previous sweep recorded", () => {
    expect(reproducesPrevious({ irHashes: ["x", "x"] }, previous)).toBe(true)
  })

  it.each([
    ["one run", ["x", "y"]],
    ["every run", ["y", "y"]],
  ])("fails when %s wrote another", (_, irHashes) => {
    expect(reproducesPrevious({ irHashes }, previous)).toBe(false)
  })

  it.each([
    ["no previous sweep at this head", { irHashes: ["x"] }, null],
    ["no baseline scan", { failed: "scan" }, previous],
    ["a previous sweep that wrote two IRs", { irHashes: ["x"] }, { irHashes: ["x", "y"] }],
    ["a previous sweep that kept no hash", { irHashes: ["x"] }, { irHashes: [] }],
  ])("says nothing with %s", (_, baselineScan, previousResult) => {
    expect(reproducesPrevious(baselineScan, previousResult)).toBeNull()
  })
})

describe("scanSchedule", () => {
  const label = ({ build, warm }) => `${build}${warm ? " (warmup)" : ""}`

  it.each([
    [
      "flips which of two builds goes first every round",
      ["baseline", "head"],
      1,
      3,
      [
        "baseline (warmup)",
        "head (warmup)",
        "head",
        "baseline",
        "baseline",
        "head",
        "head",
        "baseline",
      ],
    ],
    ["runs a lone build every round", ["head"], 2, 1, ["head (warmup)", "head (warmup)", "head"]],
  ])("%s, warmup included", (_, builds, warmup, runs, order) => {
    expect(scanSchedule(builds, warmup, runs).map(label)).toEqual(order)
  })
})

describe("comparedFields", () => {
  const previous = sweep({}, measured("zod"))
  const before = { scanWallMsMedian: 2390, diff: { wallMs: 5400, exitCode: 0 } }
  const scanned = (hash, exitCode = 0) => ({
    runs: [run({ hash, measurement: { exitCode } })],
    warnings: "⚠ baseline",
  })
  const scan = expect.objectContaining({ wallMsMedian: 1000, irHashes: ["x"] })

  it.each([
    ["no previous run or baseline", null, null, {}],
    ["a previous run that left the repository out", sweep({}), null, { previous: null }],
    ["a previous run at the same pins", previous, null, { previous: before }],
    [
      "a baseline that did not initialise",
      null,
      { failed: "init", fault: "exit 2", warnings: "⚠ init" },
      { baseline: { failed: "init", fault: "exit 2", warnings: "⚠ init" } },
    ],
    [
      "a baseline whose scan failed",
      null,
      scanned("x", 2),
      { baseline: { failed: "scan", fault: "run 1 of 1: exit 2", warnings: "⚠ baseline" } },
    ],
    [
      "a baseline that wrote the previous run's IR",
      previous,
      scanned("x"),
      { previous: before, baseline: { scan, reproduced: true } },
    ],
    [
      "a baseline and no previous run to check it against",
      null,
      scanned("x"),
      { baseline: { scan, reproduced: null } },
    ],
  ])("records %s", (_, previousSweep, baseline, fields) => {
    expect(comparedFields(previousSweep, REPO, baseline)).toEqual(fields)
  })
})

describe("renderReport — the Diff table", () => {
  const sized = (id, reportBytes) => measured(id, { diff: { ...measured(id).diff, reportBytes } })

  function diffTable(report) {
    const lines = renderReport(report).split("\n")
    return lines.slice(lines.indexOf("## Diff (`base..head`, 50 commits apart)") + 2)
  }

  it("gives each report's size, marking one over the comment budget", () => {
    const table = diffTable(
      sweep({}, sized("hono", 31_270), sized("zod", 106_371), sized("nest", null)),
    )
    expect(table.slice(0, 2)).toEqual([
      "| Repo | Wall | Peak RSS | Exit | Added | Removed | Changed | Moved | diff.md |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ])
    expect(table.slice(2, 5)).toEqual([
      "| `hono` | 5.40 s | 146 MiB | 0 | 1 | 0 | 2 | 0 | 30.5 KiB |",
      "| `zod` | 5.40 s | 146 MiB | 0 | 1 | 0 | 2 | 0 | 103.9 KiB ⚠ |",
      "| `nest` | 5.40 s | 146 MiB | 0 | 1 | 0 | 2 | 0 | — |",
    ])
    expect(table[6]).toMatch(/^`diff\.md` is the report without a size cap\./)
  })

  it("leaves the column out of a sweep recorded before the report was measured", () => {
    const table = diffTable(sweep({}, measured("hono")))
    expect(table.slice(0, 2)).toEqual([
      "| Repo | Wall | Peak RSS | Exit | Added | Removed | Changed | Moved |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
    ])
    expect(table.join("\n")).not.toContain("size cap")
  })
})

describe("renderReport — against the previous run", () => {
  function comparison(report) {
    const text = renderReport(report)
    const at = text.indexOf("## Against the previous run")
    return at === -1 ? null : text.slice(at).trimEnd().split("\n")
  }

  function table(lines) {
    const at = lines.findIndex((line) => line.startsWith("| Repo |"))
    return at === -1 ? [] : lines.slice(at)
  }

  it("puts the same-runner change beside the change across runners, naming both runners", () => {
    const lines = comparison(
      sweep(
        { previous: PREVIOUS_RUN, baseline: BASELINE },
        measured("zod", {
          previous: { scanWallMsMedian: 2650, diff: { wallMs: 4080, exitCode: 0 } },
          baseline: {
            scan: { wallMsMedian: 1990 },
            diff: { wallMs: 4080, exitCode: 0 },
            reproduced: true,
          },
        }),
        measured("nest", {
          previous: null,
          baseline: { scan: { wallMsMedian: 2390 }, reproduced: null },
        }),
        measured("hono", { previous: null, baseline: { failed: "init", fault: "exit 2" } }),
        measured("trpc", {
          previous: null,
          baseline: { failed: "harness", fault: "git checkout failed:\nfatal: a | b" },
        }),
        { id: "cal-com", failed: "scan" },
      ),
    )

    expect(lines[2]).toMatch(/^\*\*Same runner\*\*: `aaaaaaaa` was rebuilt on this runner/)
    expect(lines[4]).toBe(
      "**Across runners**: the 2000-01-01 run measured `aaaaaaaa` on 4× CPU-A · Node v24.0.0; " +
        "this run is on 4× CPU-B · Node v24.1.0. A wall time that moved here may have moved with the runner.",
    )
    expect(table(lines)).toEqual([
      "| Repo | Scan, same runner | Diff, same runner | Previous IRs | Scan, across runners | Diff, across runners |",
      "|---|---:|---:|:--:|---:|---:|",
      "| `zod` | 1.99 → 2.39 s (+20%) | 4.08 → 5.40 s (+32%) | ✓ | 2.65 → 2.39 s (−10%) | 4.08 → 5.40 s (+32%) |",
      "| `nest` | 2.39 → 2.39 s (+0%) | — | n/a | — | — |",
      "| `hono` | ✗ init (exit 2) | — | — | — | — |",
      "| `trpc` | ✗ harness (git checkout failed: fatal: a \\| b) | — | — | — | — |",
      "| `cal-com` | — | — | — | — | — |",
    ])
  })

  it.each([
    ["the baseline's", 1, "✗ exit 1 → 5.40 s", "4.08 → 5.40 s (+32%)"],
    ["this build's", 1, "4.08 s → ✗ exit 1", "4.08 s → ✗ exit 1"],
    ["the previous run's", 1, "4.08 → 5.40 s (+32%)", "✗ exit 1 → 5.40 s"],
    ["the baseline's", 3, "4.08 → 5.40 s (+32%)", "4.08 → 5.40 s (+32%)"],
    ["this build's", 3, "4.08 → 5.40 s (+32%)", "4.08 → 5.40 s (+32%)"],
  ])(
    "compares diff times only between completed runs: %s exit %i",
    (side, exitCode, sameRunner, acrossRunners) => {
      const exits = {
        "the baseline's": 0,
        "this build's": 0,
        "the previous run's": 0,
        [side]: exitCode,
      }
      const result = measured("zod", {
        diff: { ...measured("zod").diff, exitCode: exits["this build's"] },
        previous: {
          scanWallMsMedian: 2390,
          diff: { wallMs: 4080, exitCode: exits["the previous run's"] },
        },
        baseline: {
          scan: { wallMsMedian: 2390 },
          diff: { wallMs: 4080, exitCode: exits["the baseline's"] },
          reproduced: true,
        },
      })
      const row = comparison(sweep({ previous: PREVIOUS_RUN, baseline: BASELINE }, result)).at(-1)
      const cells = row.slice(2, -2).split(" | ")
      expect([cells[2], cells[5]]).toEqual([sameRunner, acrossRunners])
    },
  )

  it("says the same runner was not measured where the baseline did not build", () => {
    const lines = comparison(sweep({ baseline: UNBUILT_BASELINE }, measured("zod")))
    expect(lines.slice(2)).toEqual([
      "**Same runner**: not measured — building `aaaaaaaa` on this runner failed, see the baseline step's log.",
    ])
  })

  it.each([
    [
      "across runners alone",
      { previous: PREVIOUS_RUN },
      { previous: { scanWallMsMedian: 2650, diff: null } },
      [
        "| Repo | Scan, across runners | Diff, across runners |",
        "|---|---:|---:|",
        "| `zod` | 2.65 → 2.39 s (−10%) | — |",
      ],
    ],
    [
      "on the same runner alone",
      { baseline: BASELINE },
      { baseline: { scan: { wallMsMedian: 2390 }, reproduced: false } },
      [
        "| Repo | Scan, same runner | Diff, same runner | Previous IRs |",
        "|---|---:|---:|:--:|",
        "| `zod` | 2.39 → 2.39 s (+0%) | — | ✗ |",
      ],
    ],
    [
      "across runners beside a baseline that did not build",
      { previous: PREVIOUS_RUN, baseline: UNBUILT_BASELINE },
      { previous: null },
      [
        "| Repo | Scan, across runners | Diff, across runners |",
        "|---|---:|---:|",
        "| `zod` | — | — |",
      ],
    ],
  ])("gives only the columns it measured, %s", (_, extra, overrides, columns) => {
    expect(table(comparison(sweep(extra, measured("zod", overrides))))).toEqual(columns)
  })

  it.each([
    ["with uncommitted changes", { dirty: true }, "measured `aaaaaaaa` + uncommitted changes on"],
    ["with no commit recorded", { commit: null }, "measured an unrecorded commit on"],
  ])("names a previous run %s", (_, change, says) => {
    const lines = comparison(sweep({ previous: { ...PREVIOUS_RUN, ...change } }, measured("zod")))
    expect(lines[2]).toContain(says)
  })

  it("leaves the section out of a sweep that compared against nothing", () => {
    expect(comparison(sweep({}, measured("zod")))).toBeNull()
  })
})

import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  countRecoverableParseErrors,
  parseArgs,
  previousResultFor,
  renderReport,
  reproducesPrevious,
  scanRunFault,
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

describe("summariseScans", () => {
  it("condemns the whole repository when any measured run failed", () => {
    const summary = summariseScans([
      run(),
      run({ measurement: { exitCode: 1 }, irWritten: false }),
      run(),
    ])
    expect(summary.failed).toBe("scan")
    expect(summary.fault).toBe("run 2 of 3: exit 1")
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

  it("rejects a flag whose value is missing, naming the flag", () => {
    expect(() => parseArgs(["--only"])).toThrow(/--only/)
    expect(() => parseArgs(["--work-dir"])).toThrow(/--work-dir/)
  })

  it("accepts the defaults and the flags the README documents", () => {
    expect(parseArgs([]).runs).toBe(3)
    expect(parseArgs(["--no-diff"]).diff).toBe(false)
    expect(parseArgs(["--only", "zod,nest"]).only).toEqual(["zod", "nest"])
  })

  it("compares against nothing unless told, and resolves what it is told to compare against", () => {
    expect(parseArgs([])).toMatchObject({ baseline: null, previous: null })
    expect(
      parseArgs(["--baseline", "prev", "--previous", "results/2026-11-01.json"]),
    ).toMatchObject({
      baseline: resolve("prev"),
      previous: resolve("results/2026-11-01.json"),
    })
    expect(() => parseArgs(["--baseline"])).toThrow(/--baseline/)
    expect(() => parseArgs(["--previous"])).toThrow(/--previous/)
  })
})

describe("previousResultFor", () => {
  const repo = { id: "zod", head: "h1", base: "b1" }
  const sweep = (...results) => ({ results })
  const measured = (overrides = {}) => ({
    id: "zod",
    head: "h1",
    base: "b1",
    scan: { wallMsMedian: 2650, irHashes: ["x", "x"] },
    diff: { wallMs: 4080 },
    ...overrides,
  })

  it("takes the previous sweep's medians and hashes for the repository at the same pins", () => {
    expect(previousResultFor(sweep(measured()), repo)).toEqual({
      scanWallMsMedian: 2650,
      diffWallMs: 4080,
      irHashes: ["x", "x"],
    })
  })

  it("reads a sweep recorded before every hash was kept by its one hash", () => {
    const earlier = measured({ scan: { wallMsMedian: 2650, irHash: "x" } })
    expect(previousResultFor(sweep(earlier), repo)?.irHashes).toEqual(["x"])
  })

  it.each([
    ["no previous sweep", null],
    ["a sweep that left the repository out", sweep(measured({ id: "nest" }))],
    ["a sweep where it failed", sweep(measured({ failed: "scan" }))],
    ["a sweep at another head", sweep(measured({ head: "h0" }))],
  ])("has nothing to compare with %s", (_, previous) => {
    expect(previousResultFor(previous, repo)).toBeNull()
  })

  it("compares the scan but not the diff across another base", () => {
    expect(previousResultFor(sweep(measured({ base: "b0" })), repo)).toMatchObject({
      scanWallMsMedian: 2650,
      diffWallMs: null,
    })
  })
})

describe("reproducesPrevious", () => {
  const previous = { irHashes: ["x", "x", "x"] }

  it("holds when every run wrote the IR the previous sweep recorded", () => {
    expect(reproducesPrevious({ irHashes: ["x", "x"] }, previous)).toBe(true)
  })

  it("fails when any run wrote another", () => {
    expect(reproducesPrevious({ irHashes: ["x", "y"] }, previous)).toBe(false)
    expect(reproducesPrevious({ irHashes: ["y", "y"] }, previous)).toBe(false)
  })

  it("says nothing without a previous sweep at these pins, or a baseline scan", () => {
    expect(reproducesPrevious({ irHashes: ["x"] }, null)).toBeNull()
    expect(reproducesPrevious({ failed: "scan" }, previous)).toBeNull()
  })
})

describe("renderReport — the Diff table", () => {
  function sweep(...diffs) {
    return {
      startedAt: "2026-10-25T00:00:00.000Z",
      generator: "0.5.0",
      options: { runs: 1, warmup: 0, diff: true },
      environment: { node: "v24.0.0", cpus: 4, cpuModel: "CPU", totalMemGiB: 16 },
      results: diffs.map(([id, reportBytes]) => ({
        id,
        scan: { wallMsMedian: 1000, peakRssKb: 120_000, exitCode: 0, warnings: "" },
        metrics: { totalCalls: 0, skippedByReason: {} },
        diff: {
          wallMs: 2000,
          peakRssKb: 150_000,
          exitCode: 0,
          summary: { added: 1, removed: 0, changed: 2, moved: 0 },
          ...(reportBytes === undefined ? {} : { reportBytes }),
        },
      })),
    }
  }

  function diffTable(report) {
    const lines = renderReport(report).split("\n")
    return lines.slice(lines.indexOf("## Diff (`base..head`, 50 commits apart)") + 2)
  }

  it("gives each report's size, marking one over the comment budget", () => {
    const table = diffTable(sweep(["hono", 31_270], ["zod", 106_371], ["nest", null]))
    expect(table.slice(0, 2)).toEqual([
      "| Repo | Wall | Peak RSS | Exit | Added | Removed | Changed | Moved | diff.md |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ])
    expect(table.slice(2, 5)).toEqual([
      "| `hono` | 2.00 s | 146 MiB | 0 | 1 | 0 | 2 | 0 | 30.5 KiB |",
      "| `zod` | 2.00 s | 146 MiB | 0 | 1 | 0 | 2 | 0 | 103.9 KiB ⚠ |",
      "| `nest` | 2.00 s | 146 MiB | 0 | 1 | 0 | 2 | 0 | — |",
    ])
    expect(table[6]).toMatch(/^`diff\.md` is the report without a size cap\./)
  })

  it("leaves the column out of a sweep recorded before the report was measured", () => {
    const table = diffTable(sweep(["hono"]))
    expect(table.slice(0, 2)).toEqual([
      "| Repo | Wall | Peak RSS | Exit | Added | Removed | Changed | Moved |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
    ])
    expect(table.join("\n")).not.toContain("size cap")
  })
})

describe("renderReport — against the previous run", () => {
  const environment = { node: "v24.22.1", cpus: 4, cpuModel: "XEON", totalMemGiB: 16 }
  const measured = (id, overrides = {}) => ({
    id,
    scan: { wallMsMedian: 2390, peakRssKb: 120_000, exitCode: 0, warnings: "" },
    metrics: { totalCalls: 0, skippedByReason: {} },
    diff: { wallMs: 5400, peakRssKb: 150_000, exitCode: 0, summary: {} },
    ...overrides,
  })
  const sweep = (extra, ...results) => ({
    startedAt: "2026-12-01T03:00:00.000Z",
    generator: "0.6.0",
    commit: "ceaa9240aaaa",
    dirty: false,
    options: { runs: 3, warmup: 1, diff: true },
    environment,
    ...extra,
    results,
  })
  const previous = {
    startedAt: "2026-11-01T03:05:43.655Z",
    commit: "3b917f21bbbb",
    dirty: false,
    environment: { node: "v24.21.0", cpus: 4, cpuModel: "EPYC", totalMemGiB: 16 },
  }
  const baseline = { commit: "3b917f21bbbb", dirty: false }

  function comparison(report) {
    const text = renderReport(report)
    const at = text.indexOf("## Against the previous run")
    return at === -1 ? null : text.slice(at).trimEnd().split("\n")
  }

  it("puts the same-runner change beside the change across runners, naming both runners", () => {
    const lines = comparison(
      sweep(
        { previous, baseline },
        measured("zod", {
          previous: { scanWallMsMedian: 2650, diffWallMs: 4080 },
          baseline: {
            scan: { wallMsMedian: 1990 },
            diff: { wallMs: 4080 },
            reproduced: true,
          },
        }),
        measured("nest", {
          previous: null,
          baseline: { scan: { wallMsMedian: 2390 }, reproduced: null },
        }),
        measured("hono", { previous: null, baseline: { failed: "init", fault: "exit 2" } }),
        { id: "cal-com", failed: "scan" },
      ),
    )

    expect(lines[2]).toMatch(/^\*\*Same runner\*\*: `3b917f21` was rebuilt on this runner/)
    expect(lines[4]).toBe(
      "**Across runners**: the 2026-11-01 run measured `3b917f21` on 4× EPYC · Node v24.21.0; " +
        "this run is on 4× XEON · Node v24.22.1. A wall time that moved here may have moved with the runner.",
    )
    expect(lines.slice(6)).toEqual([
      "| Repo | Scan, same runner | Diff, same runner | Previous IRs | Scan, across runners | Diff, across runners |",
      "|---|---:|---:|:--:|---:|---:|",
      "| `zod` | 1.99 → 2.39 s (+20%) | 4.08 → 5.40 s (+32%) | ✓ | 2.65 → 2.39 s (−10%) | 4.08 → 5.40 s (+32%) |",
      "| `nest` | 2.39 → 2.39 s (+0%) | — | n/a | — | — |",
      "| `hono` | ✗ init | — | — | — | — |",
      "| `cal-com` | — | — | — | — | — |",
    ])
  })

  it("gives only the columns it has a measurement for", () => {
    const acrossOnly = comparison(
      sweep(
        { previous },
        measured("zod", { previous: { scanWallMsMedian: 2650, diffWallMs: null } }),
      ),
    )
    expect(acrossOnly.slice(4)).toEqual([
      "| Repo | Scan, across runners | Diff, across runners |",
      "|---|---:|---:|",
      "| `zod` | 2.65 → 2.39 s (−10%) | — |",
    ])

    const sameOnly = comparison(
      sweep(
        { baseline },
        measured("zod", { baseline: { scan: { wallMsMedian: 2390 }, reproduced: false } }),
      ),
    )
    expect(sameOnly.slice(4)).toEqual([
      "| Repo | Scan, same runner | Diff, same runner | Previous IRs |",
      "|---|---:|---:|:--:|",
      "| `zod` | 2.39 → 2.39 s (+0%) | — | ✗ |",
    ])
  })

  it("names a previous run with uncommitted changes, or with no commit recorded", () => {
    const dirty = comparison(sweep({ previous: { ...previous, dirty: true } }, measured("zod")))
    expect(dirty[2]).toContain("measured `3b917f21` + uncommitted changes on")
    const unrecorded = comparison(
      sweep({ previous: { ...previous, commit: null } }, measured("zod")),
    )
    expect(unrecorded[2]).toContain("measured an unrecorded commit on")
  })

  it("leaves the section out of a sweep that compared against nothing", () => {
    expect(comparison(sweep({}, measured("zod")))).toBeNull()
  })
})

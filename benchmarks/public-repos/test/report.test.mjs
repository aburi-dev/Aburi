import { describe, expect, it } from "vitest"
import {
  authoredCalls,
  countRecoverableParseErrors,
  parseArgs,
  renderReport,
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

describe("authoredCalls", () => {
  const buckets = (noMatch, external) => ({
    localScope: 0,
    external,
    dynamic: 0,
    ambiguous: 0,
    noMatch,
  })

  it("leaves out the calls of generated files, bucket by bucket", () => {
    const census = {
      totalCalls: 20,
      resolvedCalls: 5,
      unresolved: buckets(10, 5),
      generated: { totalCalls: 12, resolvedCalls: 1, unresolved: buckets(8, 3) },
    }
    expect(authoredCalls(census)).toEqual({
      totalCalls: 8,
      resolvedCalls: 4,
      unresolved: buckets(2, 2),
      generatedCalls: 12,
    })
  })

  it("counts no generated call for a census without the block, and nothing for no census", () => {
    const census = { totalCalls: 3, resolvedCalls: 2, unresolved: buckets(1, 0) }
    expect(authoredCalls(census)).toEqual({ ...census, generatedCalls: 0 })
    expect(authoredCalls(null)).toBeNull()
  })
})

describe("renderReport — the Call resolution table", () => {
  function sweep(...metrics) {
    return {
      startedAt: "2026-11-01T00:00:00.000Z",
      generator: "0.6.0",
      options: { runs: 1, warmup: 0, diff: false },
      environment: { node: "v24.0.0", cpus: 4, cpuModel: "CPU", totalMemGiB: 16 },
      results: metrics.map(([id, generatedCalls]) => ({
        id,
        scan: { wallMsMedian: 1000, peakRssKb: 120_000, exitCode: 0, warnings: "" },
        metrics: {
          components: 1,
          totalCalls: 200,
          resolvedCalls: 50,
          dependencies: 40,
          skippedFiles: 0,
          skippedByReason: {},
          ...(generatedCalls === undefined ? {} : { generatedCalls }),
        },
      })),
    }
  }

  function resolutionTable(report) {
    const lines = renderReport(report).split("\n")
    return lines.slice(lines.indexOf("## Call resolution and losses") + 2)
  }

  it("counts the generated files' calls beside the authored code's rate", () => {
    expect(resolutionTable(sweep(["shadcn-ui", 15_485], ["hono", 0])).slice(0, 4)).toEqual([
      "| Repo | Components | Calls | Resolved | Resolved % | Generated calls | Deps | Parse errors | Files lost | Reasons |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
      "| `shadcn-ui` | 1 | 200 | 50 | 25.0% | 15485 | 40 | 0 | 0 | — |",
      "| `hono` | 1 | 200 | 50 | 25.0% | 0 | 40 | 0 | 0 | — |",
    ])
  })

  it("leaves the column out of a sweep recorded before generated files were counted apart", () => {
    expect(resolutionTable(sweep(["hono"])).slice(0, 2)).toEqual([
      "| Repo | Components | Calls | Resolved | Resolved % | Deps | Parse errors | Files lost | Reasons |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ])
  })
})

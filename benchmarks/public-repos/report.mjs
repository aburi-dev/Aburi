import { resolve } from "node:path"
import { ABURI_COMMENT_BODY_MAX_BYTES } from "@aburi/github-action"
import { authoredCallCensus } from "@aburi/types"
import { DEFAULT_WORK_DIR, requireCount, requireValue } from "./args.mjs"

const COMPLETED_EXIT_CODES = new Set([0, 3])

function runFault(measurement) {
  if (measurement.wallMs == null) return measurement.failure ?? "no measurement line"
  if (!COMPLETED_EXIT_CODES.has(measurement.exitCode)) return `exit ${measurement.exitCode}`
  return null
}

export function scanRunFault(measurement, irWritten) {
  return runFault(measurement) ?? (irWritten ? null : "no IR was written")
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function summariseScans(runs, options = {}) {
  const { totalFiles = null, warnings = "" } = options
  for (const [index, entry] of runs.entries()) {
    const fault = scanRunFault(entry.measurement, entry.irWritten)
    if (fault) {
      return { failed: "scan", fault: `run ${index + 1} of ${runs.length}: ${fault}`, warnings }
    }
  }
  const wallMsSamples = runs.map((entry) => entry.measurement.wallMs)
  const hashes = runs.map((entry) => entry.hash)
  const wallMsMedian = median(wallMsSamples)
  const exitCodes = runs.map((entry) => entry.measurement.exitCode)
  return {
    runs: runs.length,
    exitCode: exitCodes[exitCodes.length - 1],
    exitCodes,
    wallMsSamples,
    wallMsMedian,
    wallMsMin: Math.min(...wallMsSamples),
    wallMsMax: Math.max(...wallMsSamples),
    peakRssKb: Math.max(...runs.map((entry) => entry.measurement.maxRssKb)),
    filesPerSecond: totalFiles == null ? null : totalFiles / (wallMsMedian / 1000),
    irHash: hashes[0],
    irHashes: hashes,
    deterministic: hashes.length < 2 ? null : hashes.every((hash) => hash === hashes[0]),
    warnings,
  }
}

export function scrubPaths(text, workDir) {
  const variants = new Set([workDir, workDir.replaceAll("\\", "/"), workDir.replaceAll("/", "\\")])
  let scrubbed = text
  for (const variant of variants) scrubbed = scrubbed.split(variant).join("<work-dir>")
  return scrubbed.replace(/\S*aburi-worktree-[A-Za-z0-9]+/g, "<base-worktree>")
}

export function countRecoverableParseErrors(warnings) {
  const counts = [...warnings.matchAll(/(\d+) file\(s\) had recoverable parse errors/g)].map(
    (match) => Number(match[1]),
  )
  return counts.length === 0 ? 0 : Math.max(...counts)
}

export function parseArgs(argv) {
  const options = {
    only: null,
    runs: 3,
    warmup: 1,
    diff: true,
    workDir: DEFAULT_WORK_DIR,
    baseline: null,
    baselineFailed: null,
    previous: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--only") options.only = requireValue(argv, ++i, "--only").split(",")
    else if (arg === "--runs") options.runs = requireCount(argv, ++i, "--runs", 1)
    else if (arg === "--warmup") options.warmup = requireCount(argv, ++i, "--warmup", 0)
    else if (arg === "--no-diff") options.diff = false
    else if (arg === "--work-dir") options.workDir = resolve(requireValue(argv, ++i, "--work-dir"))
    else if (arg === "--baseline") options.baseline = resolve(requireValue(argv, ++i, "--baseline"))
    else if (arg === "--previous") options.previous = resolve(requireValue(argv, ++i, "--previous"))
    else if (arg === "--baseline-failed") {
      options.baselineFailed = requireValue(argv, ++i, "--baseline-failed")
    } else throw new Error(`Unknown flag: ${arg}`)
  }
  if (options.baseline !== null && options.baselineFailed !== null) {
    throw new Error("--baseline and --baseline-failed both name the baseline build; pass one.")
  }
  return options
}

export function readSweep(text, path) {
  let sweep
  try {
    sweep = JSON.parse(text)
  } catch (error) {
    throw new Error(`--previous ${path} is not JSON: ${error.message}`)
  }
  const isObject = (value) => typeof value === "object" && value !== null
  const refuse = (why) => {
    throw new Error(`--previous ${path} is not a sweep's results file: ${why}.`)
  }
  const missing = [
    typeof sweep?.startedAt === "string" ? null : "startedAt",
    isObject(sweep?.environment) ? null : "environment",
    Array.isArray(sweep?.results) ? null : "results",
  ].filter((field) => field !== null)
  if (missing.length > 0) refuse(`it has no ${missing.join(", ")}`)
  const malformed = sweep.results.findIndex(
    (entry) =>
      !isObject(entry) ||
      typeof entry.id !== "string" ||
      (!entry.failed && (typeof entry.head !== "string" || !isObject(entry.scan))),
  )
  if (malformed !== -1) {
    refuse(`results[${malformed}] needs an id, and a head and a scan unless it failed`)
  }
  return sweep
}

export function previousResultFor(previous, repo) {
  const result = previous?.results.find((entry) => entry.id === repo.id)
  if (result === undefined || result.failed || result.head !== repo.head) return null
  const { irHash, irHashes } = result.scan
  return {
    scanWallMsMedian: result.scan.wallMsMedian,
    diff:
      result.base === repo.base && result.diff
        ? { wallMs: result.diff.wallMs, exitCode: result.diff.exitCode }
        : null,
    irHashes: irHashes ?? (irHash === undefined ? [] : [irHash]),
  }
}

export function reproducesPrevious(baselineScan, previousResult) {
  if (previousResult === null || baselineScan.failed) return null
  // A previous sweep that wrote two IRs, or kept no hash, recorded no single IR to reproduce.
  const recorded = new Set(previousResult.irHashes)
  if (recorded.size !== 1) return null
  return baselineScan.irHashes.every((hash) => recorded.has(hash))
}

// Flipping the order each round keeps a drift through the sweep from favouring the build run second.
export function scanSchedule(builds, warmup, runs) {
  return Array.from({ length: warmup + runs }, (_, round) =>
    (round % 2 === 0 ? builds : builds.toReversed()).map((build) => ({
      build,
      warm: round < warmup,
    })),
  ).flat()
}

export function comparedFields(previous, repo, baseline) {
  const before = previousResultFor(previous, repo)
  const fields = {}
  if (previous !== null) {
    fields.previous =
      before === null ? null : { scanWallMsMedian: before.scanWallMsMedian, diff: before.diff }
  }
  if (baseline === null) return fields
  if (baseline.failed) {
    fields.baseline = baseline
    return fields
  }
  const scan = summariseScans(baseline.runs, { warnings: baseline.warnings })
  fields.baseline = scan.failed ? scan : { scan, reproduced: reproducesPrevious(scan, before) }
  return fields
}

function formatMiB(kb) {
  return kb == null ? "—" : (kb / 1024).toFixed(0)
}

function formatReportBytes(bytes) {
  if (bytes == null) return "—"
  return `${(bytes / 1024).toFixed(1)} KiB${bytes > ABURI_COMMENT_BODY_MAX_BYTES ? " ⚠" : ""}`
}

function formatSeconds(ms) {
  return ms == null ? "—" : (ms / 1000).toFixed(2)
}

function formatCount(value) {
  return value == null ? "—" : String(value)
}

function row(cells) {
  return `| ${cells.join(" | ")} |`
}

function dashes(count) {
  return Array.from({ length: count }, () => "—")
}

function formatChange(beforeMs, afterMs) {
  if (beforeMs == null || afterMs == null) return "—"
  const percent = ((afterMs - beforeMs) / beforeMs) * 100
  const sign = percent < 0 ? "−" : "+"
  return `${formatSeconds(beforeMs)} → ${formatSeconds(afterMs)} s (${sign}${Math.abs(percent).toFixed(0)}%)`
}

function formatDiffChange(before, after) {
  if (before == null || after == null) return "—"
  const faults = [before, after].map(runFault)
  if (faults.every((fault) => fault === null)) return formatChange(before.wallMs, after.wallMs)
  const [from, to] = [before, after].map((diff, side) =>
    faults[side] === null ? `${formatSeconds(diff.wallMs)} s` : `✗ ${faults[side]}`,
  )
  return `${from} → ${to}`
}

function formatFailure({ failed, fault }) {
  const cell = fault ? fault.replace(/\s+/g, " ").replaceAll("|", "\\|") : ""
  return `✗ ${failed}${cell ? ` (${cell})` : ""}`
}

function formatRun(environment) {
  return `${environment.cpus}× ${environment.cpuModel} · Node ${environment.node}`
}

function formatExitCodes(scan) {
  const codes = scan.exitCodes ?? [scan.exitCode]
  if (codes.every((code) => code === codes[0])) return formatCount(codes[0])
  return codes.join("/")
}

/**
 * The census of the code a repository's authors wrote: a build script's output can hold more
 * calls than the code around it, and its calls are counted apart so they do not set the rate.
 */
export function authoredCalls(census) {
  if (census === null) return null
  return { ...authoredCallCensus(census), generatedCalls: census.generated?.totalCalls ?? 0 }
}

export function renderReport(report) {
  const lines = []
  const { environment, results } = report
  lines.push("# Public-repository benchmark")
  lines.push("")
  lines.push(
    `Run ${report.startedAt} · aburi ${report.generator ?? "workspace build"}` +
      `${report.commit ? ` at \`${report.commit.slice(0, 8)}\`${report.dirty ? " + uncommitted changes" : ""}` : ""} · ` +
      `Node ${environment.node} · ${environment.cpus}× ${environment.cpuModel} · ` +
      `${environment.totalMemGiB} GiB RAM · ${report.options.runs} measured run(s) after ` +
      `${report.options.warmup} warmup.`,
  )
  lines.push("")
  lines.push("## Scan")
  lines.push("")
  lines.push(
    row([
      "Repo",
      "Files",
      "Kept",
      "Dropped",
      "Median",
      "Min–max",
      "files/s",
      "Peak RSS",
      "IR",
      "Exit",
      "Deterministic",
    ]),
  )
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|:--:|:--:|")
  for (const result of results) {
    if (result.failed) {
      lines.push(row([`\`${result.id}\``, ...dashes(8), formatFailure(result), "—"]))
      continue
    }
    const { scan, metrics } = result
    lines.push(
      row([
        `\`${result.id}\``,
        formatCount(metrics.totalFiles),
        formatCount(metrics.keptSymbols),
        formatCount(metrics.droppedSymbols),
        `${formatSeconds(scan.wallMsMedian)} s`,
        `${formatSeconds(scan.wallMsMin)}–${formatSeconds(scan.wallMsMax)} s`,
        scan.filesPerSecond == null ? "—" : scan.filesPerSecond.toFixed(0),
        `${formatMiB(scan.peakRssKb)} MiB`,
        metrics.irBytes == null ? "—" : `${(metrics.irBytes / 1024 / 1024).toFixed(1)} MiB`,
        formatExitCodes(scan),
        scan.deterministic == null ? "n/a" : scan.deterministic ? "✓" : "✗",
      ]),
    )
  }
  lines.push("")
  // A sample recorded before generated files were counted apart renders as it always did.
  const generatedCounted = results.some((result) => result.metrics?.generatedCalls != null)
  lines.push("## Call resolution and losses")
  lines.push("")
  lines.push(
    row([
      "Repo",
      "Components",
      "Calls",
      "Resolved",
      "Resolved %",
      ...(generatedCounted ? ["Generated calls"] : []),
      "Deps",
      "Parse errors",
      "Files lost",
      "Reasons",
    ]),
  )
  lines.push(`|---|---:|---:|---:|---:|${generatedCounted ? "---:|" : ""}---:|---:|---:|---|`)
  for (const result of results) {
    if (result.failed) {
      lines.push(
        row([`\`${result.id}\``, ...dashes(generatedCounted ? 8 : 7), `✗ ${result.failed}`]),
      )
      continue
    }
    const metrics = result.metrics
    const share =
      metrics.totalCalls > 0 && metrics.resolvedCalls != null
        ? `${((metrics.resolvedCalls / metrics.totalCalls) * 100).toFixed(1)}%`
        : "—"
    const reasons =
      Object.entries(metrics.skippedByReason)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(", ") || "—"
    lines.push(
      row([
        `\`${result.id}\``,
        formatCount(metrics.components),
        formatCount(metrics.totalCalls),
        formatCount(metrics.resolvedCalls),
        share,
        ...(generatedCounted ? [formatCount(metrics.generatedCalls)] : []),
        formatCount(metrics.dependencies),
        String(countRecoverableParseErrors(result.scan.warnings ?? "")),
        formatCount(metrics.skippedFiles),
        reasons,
      ]),
    )
  }
  if (results.some((result) => result.diff)) {
    // A sample recorded before the report was measured renders as it always did.
    const reported = results.some((result) => result.diff?.reportBytes != null)
    lines.push("")
    lines.push("## Diff (`base..head`, 50 commits apart)")
    lines.push("")
    lines.push(
      row([
        "Repo",
        "Wall",
        "Peak RSS",
        "Exit",
        "Added",
        "Removed",
        "Changed",
        "Moved",
        ...(reported ? ["diff.md"] : []),
      ]),
    )
    lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|${reported ? "---:|" : ""}`)
    for (const result of results) {
      if (!result.diff) continue
      const summary = result.diff.summary ?? {}
      lines.push(
        row([
          `\`${result.id}\``,
          `${formatSeconds(result.diff.wallMs)} s`,
          `${formatMiB(result.diff.peakRssKb)} MiB`,
          formatCount(result.diff.exitCode),
          formatCount(summary.added),
          formatCount(summary.removed),
          formatCount(summary.changed),
          formatCount(summary.moved),
          ...(reported ? [formatReportBytes(result.diff.reportBytes)] : []),
        ]),
      )
    }
    if (reported) {
      lines.push("")
      lines.push(
        `\`diff.md\` is the report without a size cap. Left to its default, the GitHub Action ` +
          `posts at most ${ABURI_COMMENT_BODY_MAX_BYTES.toLocaleString("en-US")} bytes of it, the ` +
          "most a pull request comment holds beside its marker, so a report marked ⚠ reaches the " +
          "pull request with sections listing names only or left out.",
      )
    }
  }
  if (report.previous || report.baseline) lines.push(...renderComparison(report))
  lines.push("")
  return `${lines.join("\n")}\n`
}

function renderComparison(report) {
  const { previous, baseline, environment, results } = report
  const lines = ["", "## Against the previous run", ""]
  const measuredBaseline = baseline !== undefined && !baseline.failed
  if (baseline?.failed) {
    lines.push(
      `**Same runner**: not measured — building \`${baseline.commit.slice(0, 8)}\` on this runner ` +
        "failed, see the baseline step's log.",
    )
    lines.push("")
  } else if (baseline) {
    lines.push(
      `**Same runner**: \`${baseline.commit.slice(0, 8)}\`${baseline.dirty ? " + uncommitted changes" : ""} ` +
        "was rebuilt on this runner and measured interleaved with this build, scan by scan, with " +
        "the same runs and warmup and the order flipped each round. The diff is one run of each, " +
        "back to back, so its change is far noisier than the scan median's. **Previous IRs** says " +
        "whether it wrote, at every run, the IR the previous run recorded for the repository (n/a " +
        "where the previous run recorded no single IR at this head).",
    )
    lines.push("")
  }
  if (previous) {
    lines.push(
      `**Across runners**: the ${previous.startedAt.slice(0, 10)} run measured ` +
        `${previous.commit ? `\`${previous.commit.slice(0, 8)}\`` : "an unrecorded commit"}` +
        `${previous.dirty ? " + uncommitted changes" : ""} on ${formatRun(previous.environment)}; ` +
        `this run is on ${formatRun(environment)}. A wall time that moved here may have moved with the runner.`,
    )
    lines.push("")
  }
  const sameRunner = measuredBaseline
    ? ["Scan, same runner", "Diff, same runner", "Previous IRs"]
    : []
  const acrossRunners = previous ? ["Scan, across runners", "Diff, across runners"] : []
  if (sameRunner.length + acrossRunners.length === 0) return lines.slice(0, -1)
  lines.push(row(["Repo", ...sameRunner, ...acrossRunners]))
  lines.push(`|---|${measuredBaseline ? "---:|---:|:--:|" : ""}${previous ? "---:|---:|" : ""}`)
  for (const result of results) {
    if (result.failed) {
      lines.push(row([`\`${result.id}\``, ...dashes(sameRunner.length + acrossRunners.length)]))
      continue
    }
    lines.push(
      row([
        `\`${result.id}\``,
        ...(measuredBaseline ? sameRunnerCells(result) : []),
        ...(previous
          ? [
              formatChange(result.previous?.scanWallMsMedian, result.scan.wallMsMedian),
              formatDiffChange(result.previous?.diff, result.diff),
            ]
          : []),
      ]),
    )
  }
  return lines
}

function sameRunnerCells({ baseline, scan, diff }) {
  if (baseline === undefined) return dashes(3)
  if (baseline.failed) return [formatFailure(baseline), "—", "—"]
  return [
    formatChange(baseline.scan.wallMsMedian, scan.wallMsMedian),
    formatDiffChange(baseline.diff, diff),
    baseline.reproduced == null ? "n/a" : baseline.reproduced ? "✓" : "✗",
  ]
}

#!/usr/bin/env node
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { cpus, totalmem } from "node:os"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveRepos } from "./args.mjs"
import {
  aburiCommit,
  aburiVersion,
  assertRunnable,
  cliEntry,
  git,
  pluginRef,
  REPO_ROOT,
  run,
} from "./checkout.mjs"
import {
  authoredCalls,
  comparedFields,
  parseArgs,
  readSweep,
  renderReport,
  scanSchedule,
  scrubPaths,
  summariseScans,
} from "./report.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD = resolve(HERE, "bench-child.mjs")

/** Enough of a failing run's output to read, taken from the head, where the first error is. */
const CAPTURED_OUTPUT_BYTES = 4000

async function ensureClone(repo, workDir) {
  const dir = resolve(workDir, repo.id)
  if (!existsSync(resolve(dir, ".git"))) {
    await mkdir(workDir, { recursive: true })
    await git(["clone", "--filter=blob:none", "--no-checkout", repo.url, dir])
  }
  // Checking the base out first fetches its blobs here, so no measured diff pays the network.
  await git(["checkout", "--force", "--detach", repo.base], dir)
  await git(["checkout", "--force", "--detach", repo.head], dir)
  await git(["clean", "-xfd", "--exclude=.aburi", "--exclude=aburi.json"], dir)
  return dir
}

function bench(cli, dir, args, timeoutMs) {
  return run(process.execPath, [CHILD, cli, ...args], { cwd: dir, timeoutMs }).then((result) => {
    const marker = result.stdout.lastIndexOf("##BENCH##")
    const measurement =
      marker === -1
        ? { wallMs: null, maxRssKb: null, exitCode: result.code, failure: "no measurement line" }
        : JSON.parse(result.stdout.slice(marker + "##BENCH##".length).trim())
    return { ...measurement, stdout: result.stdout, stderr: result.stderr, signal: result.signal }
  })
}

async function hashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

function readIrMetrics(ir, irBytes) {
  const stats = ir.stats ?? {}
  const calls = authoredCalls(stats.callResolution ?? null)
  const skipped = stats.skippedFiles ?? []
  const skippedByReason = {}
  for (const entry of skipped) {
    skippedByReason[entry.reason] = (skippedByReason[entry.reason] ?? 0) + 1
  }
  return {
    components: ir.components?.length ?? null,
    totalFiles: stats.totalFiles ?? null,
    parsedFiles: stats.parsedFiles ?? null,
    keptSymbols: stats.keptSymbols ?? null,
    droppedSymbols: stats.droppedSymbols ?? null,
    symbols: ir.symbols?.length ?? null,
    dependencies: ir.dependencies?.length ?? null,
    totalCalls: calls?.totalCalls ?? null,
    resolvedCalls: calls?.resolvedCalls ?? null,
    unresolved: calls?.unresolved ?? null,
    generatedCalls: calls?.generatedCalls ?? null,
    skippedFiles: skipped.length,
    skippedByReason,
    skippedSample: skipped.slice(0, 5),
    irBytes,
  }
}

async function initialise(cli, root, dir, configPath, label) {
  const init = await bench(cli, dir, ["init", "--force"], 300_000)
  process.stderr.write(`  init${label} ${init.wallMs?.toFixed(0)} ms (exit ${init.exitCode})\n`)
  if (init.exitCode !== 0) return { init, detected: null }
  const config = JSON.parse(await readFile(resolve(dir, "aburi.json"), "utf8"))
  const detected = {
    languages: [...(config.languages ?? [])],
    frameworks: [...(config.frameworks ?? [])],
    effects: [...(config.effects ?? [])],
  }
  for (const bucket of ["languages", "frameworks", "effects"]) {
    if (!config[bucket]) continue
    config[bucket] = config[bucket].map((ref) => pluginRef(ref, root))
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return { init, detected }
}

async function measureScan(build, dir, warm) {
  await rm(build.irPath, { force: true })
  const measurement = await bench(
    build.cli,
    dir,
    ["scan", "--no-timestamp", ...build.scanArgs],
    1_800_000,
  )
  process.stderr.write(
    `  scan${build.label}${warm ? " (warmup)" : ""} ${measurement.wallMs?.toFixed(0)} ms · ` +
      `${(measurement.maxRssKb / 1024).toFixed(0)} MiB (exit ${measurement.exitCode})\n`,
  )
  build.stderr = measurement.stderr
  if (warm) return
  const irWritten = existsSync(build.irPath)
  build.runs.push({ measurement, irWritten, hash: irWritten ? await hashFile(build.irPath) : null })
}

async function measureDiff(build, dir, repo, outputDir, capture) {
  await rm(resolve(dir, outputDir), { recursive: true, force: true })
  const measurement = await bench(
    build.cli,
    dir,
    ["diff", `${repo.base}..${repo.head}`, "--output-dir", outputDir, "--config", build.config],
    1_800_000,
  )
  process.stderr.write(
    `  diff${build.label} ${measurement.wallMs?.toFixed(0)} ms · ` +
      `${(measurement.maxRssKb / 1024).toFixed(0)} MiB (exit ${measurement.exitCode})\n`,
  )
  const diffPath = resolve(dir, outputDir, "diff.json")
  const reportPath = resolve(dir, outputDir, "diff.md")
  return {
    wallMs: measurement.wallMs,
    peakRssKb: measurement.maxRssKb,
    exitCode: measurement.exitCode,
    summary: existsSync(diffPath)
      ? (JSON.parse(await readFile(diffPath, "utf8")).summary ?? null)
      : null,
    reportBytes: existsSync(reportPath) ? (await stat(reportPath)).size : null,
    warnings: capture(measurement.stderr),
  }
}

function harnessFault(error, workDir) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    failed: "harness",
    fault: scrubPaths(message, workDir).slice(0, CAPTURED_OUTPUT_BYTES),
  }
}

async function measureRepo(repo, options, previous) {
  const started = Date.now()
  const capture = (text) => scrubPaths(text, options.workDir).slice(0, CAPTURED_OUTPUT_BYTES)
  process.stderr.write(`\n=== ${repo.id} ===\n`)
  const dir = await ensureClone(repo, options.workDir)

  // The comparison is optional, so a fault on the baseline's side is recorded against it alone.
  let baseline = null
  let baselineFault = null
  const onBaseline = async (step) => {
    try {
      await step()
    } catch (error) {
      baselineFault = harnessFault(error, options.workDir)
      process.stderr.write(`  baseline harness fault: ${baselineFault.fault}\n`)
    }
  }

  // The baseline initialises first, so the clone's own aburi.json is this build's.
  if (options.baseline !== null) {
    await onBaseline(async () => {
      const config = resolve(options.workDir, `${repo.id}.baseline.json`)
      const cli = cliEntry(options.baseline)
      const { init } = await initialise(cli, options.baseline, dir, config, " (baseline)")
      if (init.exitCode !== 0) {
        baselineFault = {
          failed: "init",
          fault: `exit ${init.exitCode}`,
          warnings: capture(init.stderr),
        }
        return
      }
      // Outside the clone, so neither build's IR sits in the tree the other scans.
      const outputDir = resolve(options.workDir, `${repo.id}.baseline-out`)
      baseline = {
        cli,
        config,
        scanArgs: ["--output-dir", outputDir, "--config", config],
        irPath: resolve(outputDir, "aburi.ir.json"),
        label: " (baseline)",
        runs: [],
        stderr: "",
      }
    })
  }

  const configPath = resolve(dir, "aburi.json")
  const { init, detected } = await initialise(cliEntry(), REPO_ROOT, dir, configPath, "")
  if (init.exitCode !== 0) {
    return {
      id: repo.id,
      head: repo.head,
      failed: "init",
      fault: `exit ${init.exitCode}`,
      init,
      elapsedMs: Date.now() - started,
    }
  }

  const head = {
    cli: cliEntry(),
    config: configPath,
    scanArgs: [],
    irPath: resolve(dir, ".aburi/aburi.ir.json"),
    label: "",
    runs: [],
    stderr: "",
  }
  const builds = baseline === null ? [head] : [baseline, head]
  for (const { build, warm } of scanSchedule(builds, options.warmup, options.runs)) {
    if (build === head) await measureScan(head, dir, warm)
    else if (baselineFault === null) await onBaseline(() => measureScan(build, dir, warm))
  }

  const scan = summariseScans(head.runs, { warnings: capture(head.stderr) })
  if (scan.failed) {
    return {
      id: repo.id,
      head: repo.head,
      failed: scan.failed,
      fault: scan.fault,
      detected,
      scan: { warnings: scan.warnings },
      elapsedMs: Date.now() - started,
    }
  }

  const ir = JSON.parse(await readFile(head.irPath, "utf8"))
  const metrics = readIrMetrics(ir, (await stat(head.irPath)).size)
  scan.filesPerSecond =
    metrics.totalFiles == null ? null : metrics.totalFiles / (scan.wallMsMedian / 1000)

  const result = {
    id: repo.id,
    url: repo.url,
    head: repo.head,
    base: repo.base,
    note: repo.note,
    detected,
    init: { wallMs: init.wallMs, maxRssKb: init.maxRssKb, exitCode: init.exitCode },
    scan,
    metrics,
  }

  if (options.diff) result.diff = await measureDiff(head, dir, repo, "out-diff", capture)

  const baselineOutcome =
    baselineFault ?? (baseline && { runs: baseline.runs, warnings: capture(baseline.stderr) })
  Object.assign(result, comparedFields(previous, repo, baselineOutcome))
  if (options.diff && result.baseline?.scan !== undefined) {
    await onBaseline(async () => {
      result.baseline.diff = await measureDiff(baseline, dir, repo, "out-diff-baseline", capture)
    })
    if (baselineFault !== null) result.baseline = baselineFault
  }

  result.elapsedMs = Date.now() - started
  return result
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  assertRunnable(options.workDir, options.baseline)
  const manifest = JSON.parse(await readFile(resolve(HERE, "repos.json"), "utf8"))
  const repos = resolveRepos(manifest, options.only)
  // Read before this sweep writes, which on a second run of the day is the same file.
  const previous =
    options.previous === null
      ? null
      : readSweep(await readFile(options.previous, "utf8"), options.previous)

  const report = {
    startedAt: new Date().toISOString(),
    options: { runs: options.runs, warmup: options.warmup, diff: options.diff },
    generator: await aburiVersion(),
    ...(await aburiCommit()),
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? "unknown",
      totalMemGiB: Math.round(totalmem() / 1024 ** 3),
    },
    ...(previous === null
      ? {}
      : {
          previous: {
            startedAt: previous.startedAt,
            commit: previous.commit ?? null,
            dirty: previous.dirty ?? null,
            environment: previous.environment,
          },
        }),
    ...(options.baseline === null ? {} : { baseline: await aburiCommit(options.baseline) }),
    ...(options.baselineFailed === null
      ? {}
      : { baseline: { commit: options.baselineFailed, failed: "build" } }),
    results: [],
  }

  const stamp = report.startedAt.slice(0, 10)
  await mkdir(resolve(HERE, "results"), { recursive: true })
  const jsonPath = resolve(HERE, "results", `${stamp}.json`)
  const mdPath = resolve(HERE, "results", `${stamp}.md`)
  const write = async () => {
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(mdPath, renderReport(report))
  }

  for (const repo of repos) {
    try {
      report.results.push(await measureRepo(repo, options, previous))
    } catch (error) {
      const fault = harnessFault(error, options.workDir)
      process.stderr.write(`  harness fault: ${fault.fault}\n`)
      report.results.push({ id: repo.id, head: repo.head, ...fault })
    }
    await write()
  }

  process.stderr.write(`\n→ ${relative(REPO_ROOT, jsonPath)}\n→ ${relative(REPO_ROOT, mdPath)}\n`)
}

await main()

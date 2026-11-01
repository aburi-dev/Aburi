#!/usr/bin/env node
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveRepos } from "./args.mjs"
import {
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
  validateCensus,
} from "./census-report.mjs"
import {
  aburiCommit,
  aburiVersion,
  assertRunnable,
  CLI_ENTRY,
  git,
  REPO_ROOT,
} from "./checkout.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const CENSUS_PATH = resolve(HERE, "no-match/sample.json")
const CODE_CHARS = 160

async function scanClone(repo, workDir) {
  const dir = resolve(workDir, repo.id)
  const configPath = resolve(dir, "aburi.json")
  const prepare = prepareCommand(repo.id, workDir)
  if (!existsSync(configPath)) {
    throw new Error(
      `${dir} has no aburi.json. Run \`${prepare}\` first: it clones the repository and writes ` +
        "the config.",
    )
  }
  const foreign = foreignPluginRefs(JSON.parse(await readFile(configPath, "utf8")), REPO_ROOT)
  if (foreign.length > 0) {
    throw new Error(
      `${configPath} loads plugins this checkout did not build: ${foreign.join(", ")}. ` +
        `Run \`${prepare}\` from this checkout first: it points the config at its builds.`,
    )
  }
  const head = await git(["rev-parse", "HEAD"], dir)
  if (head !== repo.head) {
    throw new Error(`${dir} is at ${head}, not the pinned ${repo.head}; the census reads the pin.`)
  }
  const { runScan } = await import(pathToFileURL(CLI_ENTRY).href)
  const outputDir = await mkdtemp(resolve(tmpdir(), "aburi-census-"))
  try {
    const report = await runScan({
      cwd: dir,
      outputDir,
      format: "json",
      suppressTimestamp: true,
      logLevel: "error",
    })
    const faults = scanFaults(report)
    if (faults.length > 0) {
      throw new Error(
        `The scan of ${repo.id} left part of it out (${faults.join("; ")}), and the census ` +
          "compares whole scans only.",
      )
    }
    const ir = JSON.parse(await readFile(report.irPath, "utf8"))
    return { dir, ir, unresolved: report.unresolvedCalls }
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
}

function baselineOf(repo, ir) {
  const stats = ir.stats.callResolution
  return {
    id: repo.id,
    head: repo.head,
    calls: stats.totalCalls,
    resolved: stats.resolvedCalls,
    unresolved: stats.unresolved,
  }
}

async function draw(options, repos) {
  const census = {
    seed: options.seed,
    perRepo: options.perRepo,
    aburi: { version: await aburiVersion(), ...(await aburiCommit()) },
    repos: [],
    categories: {},
    samples: [],
  }
  for (const repo of repos) {
    process.stderr.write(`scanning ${repo.id}\n`)
    const { dir, ir, unresolved } = await scanClone(repo, options.workDir)
    census.repos.push(baselineOf(repo, ir))
    const fileOf = new Map(ir.symbols.map((symbol) => [symbol.id, symbol.source.file]))
    const frame = unresolved.filter((call) => call.bucket === "no-match")
    const lines = new Map()
    for (const index of drawIndices(frame.length, options.perRepo, `${options.seed}:${repo.id}`)) {
      const call = frame[index]
      const file = fileOf.get(call.symbolId)
      if (!lines.has(file))
        lines.set(file, (await readFile(resolve(dir, file), "utf8")).split("\n"))
      census.samples.push({
        repo: repo.id,
        file,
        line: call.line,
        symbol: call.symbolId,
        target: call.target,
        test: isTestPath(file),
        code: (lines.get(file)[call.line - 1] ?? "").trim().slice(0, CODE_CHARS),
        category: null,
        expected: null,
        expectedSymbol: null,
        note: null,
      })
    }
  }
  process.stdout.write(`${JSON.stringify(census, null, 2)}\n`)
}

async function check(options, manifest) {
  const census = JSON.parse(await readFile(CENSUS_PATH, "utf8"))
  validateCensus(census)
  const current = new Map()
  const baselines = []
  for (const repo of censusRepos(manifest, census)) {
    process.stderr.write(`scanning ${repo.id}\n`)
    const { ir, unresolved } = await scanClone(repo, options.workDir)
    current.set(repo.id, callSitesOf(ir, unresolved))
    baselines.push({
      recorded: census.repos.find((entry) => entry.id === repo.id),
      now: baselineOf(repo, ir),
    })
  }
  process.stdout.write(`${renderResolution(baselines)}\n${renderCheck(census, current)}`)
}

async function main() {
  const options = parseCensusArgs(process.argv.slice(2))
  if (options.mode === "shares") {
    process.stdout.write(renderShares(JSON.parse(await readFile(CENSUS_PATH, "utf8"))))
    return
  }
  assertRunnable(options.workDir)
  const manifest = JSON.parse(await readFile(resolve(HERE, "repos.json"), "utf8"))
  if (options.mode === "draw") await draw(options, resolveRepos(manifest, options.only))
  else await check(options, manifest)
}

await main()

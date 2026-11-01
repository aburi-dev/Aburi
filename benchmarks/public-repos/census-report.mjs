import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { containsPath, DEFAULT_WORK_DIR, requireCount, requireValue } from "./args.mjs"

export const DEFAULT_CENSUS_REPOS = ["zod", "hono", "trpc", "nest"]
export const DEFAULT_PER_REPO = 75
export const DEFAULT_SEED = "no-match"

/** What a category's rule, or type information where the category needs it, makes of the call. */
export const EXPECTED = ["edge", "external", "local-scope", "dynamic", "untyped"]

/** Where a sampled call lands on a later run; `gone` when no call site matches its key. */
export const OUTCOMES = [
  "no-match",
  "resolved",
  "local-scope",
  "external",
  "dynamic",
  "ambiguous",
  "gone",
]

// No tier can name the target of an `any` receiver, so `no-match` is the right answer for it.
const SETTLED_AS = {
  edge: "resolved",
  external: "external",
  "local-scope": "local-scope",
  dynamic: "dynamic",
  untyped: "no-match",
}

const Z_95 = 1.959964

export function parseCensusArgs(argv) {
  const [mode, ...rest] = argv
  if (mode !== "draw" && mode !== "shares" && mode !== "check") {
    throw new Error(
      `The first argument is the mode, \`draw\`, \`shares\` or \`check\` (got ${mode ?? "none"}).`,
    )
  }
  const options = {
    mode,
    only: DEFAULT_CENSUS_REPOS,
    perRepo: DEFAULT_PER_REPO,
    seed: DEFAULT_SEED,
    workDir: DEFAULT_WORK_DIR,
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (mode !== "shares" && arg === "--work-dir")
      options.workDir = resolve(requireValue(rest, ++i, arg))
    else if (mode === "draw" && arg === "--only")
      options.only = requireValue(rest, ++i, arg).split(",")
    else if (mode === "draw" && arg === "--per-repo")
      options.perRepo = requireCount(rest, ++i, arg, 1)
    else if (mode === "draw" && arg === "--seed") options.seed = requireValue(rest, ++i, arg)
    else throw new Error(`Unknown flag for \`${mode}\`: ${arg}`)
  }
  return options
}

export function prepareCommand(id, workDir) {
  const at = /\s/.test(workDir) ? JSON.stringify(workDir) : workDir
  return (
    `node benchmarks/public-repos/run.mjs --only ${id} --runs 1 --warmup 0 --no-diff` +
    (workDir === DEFAULT_WORK_DIR ? "" : ` --work-dir ${at}`)
  )
}

export function censusRepos(manifest, census) {
  return census.repos.map((recorded) => {
    const pinned = manifest.repos.find((repo) => repo.id === recorded.id)
    if (pinned === undefined) {
      throw new Error(`sample.json samples ${recorded.id}, which repos.json no longer pins.`)
    }
    if (pinned.head !== recorded.head) {
      throw new Error(
        `repos.json pins ${recorded.id} at ${pinned.head}, but the census sampled ` +
          `${recorded.head}; its call sites are not comparable across pins.`,
      )
    }
    return pinned
  })
}

const PLUGIN_BUCKETS = ["languages", "frameworks", "effects"]

/** `run.mjs` points a clone's config at one checkout's builds, and every checkout shares the clones. */
export function foreignPluginRefs(config, root) {
  return PLUGIN_BUCKETS.flatMap((bucket) => config[bucket] ?? []).filter(
    (ref) => !ref.startsWith("file:") || !containsPath(root, fileURLToPath(ref)),
  )
}

const LISTED_SKIPS = 3

export function scanFaults(report) {
  const faults = []
  if (report.skipped.length > 0) {
    const listed = report.skipped
      .slice(0, LISTED_SKIPS)
      .map((file) => `${file.path} (${file.reason})`)
    const more = report.skipped.length - listed.length
    faults.push(
      `${report.skipped.length} file(s) skipped: ${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
    )
  }
  if (report.extractionFailures.length > 0) {
    faults.push(`${report.extractionFailures.length} extraction failure(s)`)
  }
  if (report.unrepresentableFiles.length > 0) {
    faults.push(`${report.unrepresentableFiles.length} file(s) no Symbol id can name`)
  }
  if (report.coverageFault !== null) faults.push(`coverage fault: ${report.coverageFault.kind}`)
  return faults
}

// FNV-1a then mulberry32: a seed string names one sequence on every platform and Node version.
export function seededRandom(seed) {
  let state = 0x811c9dc5
  for (const char of seed) {
    state ^= char.codePointAt(0)
    state = Math.imul(state, 0x01000193) >>> 0
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function drawIndices(populationSize, count, seed) {
  const random = seededRandom(seed)
  const pool = Array.from({ length: populationSize }, (_, index) => index)
  const take = Math.min(count, populationSize)
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (populationSize - i))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, take).sort((a, b) => a - b)
}

const TEST_DIRECTORY = /(^|\/)(__tests__|__mocks__|tests?|spec|e2e)\//
const TEST_FILE = /\.(test|spec|test-d|bench)\.[cm]?[jt]sx?$/

export function isTestPath(path) {
  return TEST_DIRECTORY.test(path) || TEST_FILE.test(path)
}

export function callSiteKey(site) {
  return `${site.symbol}\0${site.line}\0${site.target}`
}

/** A Symbol may call one target twice on a line; the census keys a site by all three, so the first stands. */
export function callSitesOf(ir, unresolved) {
  const sites = new Map()
  for (const symbol of ir.symbols) {
    for (const call of symbol.calls ?? []) {
      const key = callSiteKey({ symbol: symbol.id, line: call.line, target: call.target })
      if (!sites.has(key)) sites.set(key, { resolved: call.resolved, bucket: null })
    }
  }
  for (const call of unresolved) {
    const site = sites.get(
      callSiteKey({ symbol: call.symbolId, line: call.line, target: call.target }),
    )
    if (site !== undefined && site.bucket === null) site.bucket = call.bucket
  }
  return sites
}

export function wilsonInterval(hits, n) {
  if (n === 0) return { low: 0, high: 1 }
  const p = hits / n
  const z2 = Z_95 * Z_95
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

/**
 * Each stratum is one repository: `population` no-match calls, `n` of them sampled, `hits` of the
 * sample in the class being counted, weighted by its population. The draw is without replacement,
 * so each stratum's variance carries the finite-population correction.
 */
export function stratifiedShare(strata) {
  const total = strata.reduce((sum, s) => sum + s.population, 0)
  let share = 0
  let variance = 0
  for (const stratum of strata) {
    const weight = stratum.population / total
    const p = stratum.hits / stratum.n
    const correction =
      stratum.population > 1 ? (stratum.population - stratum.n) / (stratum.population - 1) : 0
    share += weight * p
    variance += ((weight * weight * p * (1 - p)) / stratum.n) * correction
  }
  return { share, margin: Z_95 * Math.sqrt(variance) }
}

const where = (samples) => samples.map((s) => `${s.repo} ${s.file}:${s.line}`).join(", ")

export function validateCensus(census) {
  const known = new Set(Object.keys(census.categories))
  const unknown = [...new Set(census.samples.map((s) => s.category))].filter((c) => !known.has(c))
  if (unknown.length > 0) {
    throw new Error(`sample.json uses categories it does not define: ${unknown.join(", ")}`)
  }
  const expected = new Set(EXPECTED)
  const strays = census.samples.filter((s) => !expected.has(s.expected))
  if (strays.length > 0) {
    throw new Error(
      `sample.json has samples with no expected outcome among ${EXPECTED.join(", ")}: ${where(strays)}`,
    )
  }
  const unnamed = census.samples.filter(
    (s) => s.expected === "edge" && typeof s.expectedSymbol !== "string",
  )
  if (unnamed.length > 0) {
    throw new Error(
      `sample.json has \`edge\` samples without the Symbol they resolve to (expectedSymbol): ${where(unnamed)}`,
    )
  }
  const named = census.samples.filter((s) => s.expected !== "edge" && s.expectedSymbol != null)
  if (named.length > 0) {
    throw new Error(
      `sample.json names an expectedSymbol for samples that expect no edge: ${where(named)}`,
    )
  }
  const repos = new Set(census.repos.map((repo) => repo.id))
  const orphans = [...new Set(census.samples.map((s) => s.repo))].filter((id) => !repos.has(id))
  if (orphans.length > 0) {
    throw new Error(
      `sample.json samples repositories it records no baseline for: ${orphans.join(", ")}`,
    )
  }
  for (const repo of census.repos) {
    const n = census.samples.filter((s) => s.repo === repo.id).length
    if (n === 0) {
      throw new Error(
        `sample.json records a baseline for ${repo.id} but samples none of its calls.`,
      )
    }
    if (n > repo.unresolved.noMatch) {
      throw new Error(
        `sample.json samples ${n} calls of ${repo.id}, whose \`no-match\` holds ${repo.unresolved.noMatch}.`,
      )
    }
  }
}

const percent = (value, digits = 0) => `${(100 * value).toFixed(digits)}%`

function strataOf(census, counts) {
  return census.repos.map((repo) => {
    const sampled = census.samples.filter((s) => s.repo === repo.id)
    return {
      population: repo.unresolved.noMatch,
      n: sampled.length,
      hits: sampled.filter(counts).length,
    }
  })
}

const SHARE_ROWS = [
  ["Resolver gap: a rule without types settles it", (needsTypes) => !needsTypes],
  [
    "…and the rule yields a call edge",
    (needsTypes, expected) => !needsTypes && expected === "edge",
  ],
  ["Needs type information", (needsTypes) => needsTypes],
  ["…and types yield a call edge", (needsTypes, expected) => needsTypes && expected === "edge"],
]

export function renderShares(census) {
  validateCensus(census)
  const needsTypes = (s) => census.categories[s.category].needsTypes
  const ids = census.repos.map((repo) => repo.id)
  const byRepo = (id) => census.samples.filter((s) => s.repo === id)
  const lines = [
    `| Category | Needs types | ${ids.map((id) => `\`${id}\``).join(" | ")} | All |`,
    `|---|:--:|${ids.map(() => "---:").join("|")}|---:|`,
  ]
  for (const [id, category] of Object.entries(census.categories)) {
    const counts = ids.map((repo) => byRepo(repo).filter((s) => s.category === id).length)
    lines.push(
      `| \`${id}\` | ${category.needsTypes ? "yes" : "no"} | ${counts.join(" | ")} | ${counts.reduce((a, b) => a + b, 0)} |`,
    )
  }
  lines.push(
    "",
    `| Category | ${EXPECTED.join(" | ")} |`,
    `|---|${EXPECTED.map(() => "---:").join("|")}|`,
  )
  for (const id of Object.keys(census.categories)) {
    const inCategory = census.samples.filter((s) => s.category === id)
    lines.push(
      `| \`${id}\` | ${EXPECTED.map((e) => inCategory.filter((s) => s.expected === e).length).join(" | ")} |`,
    )
  }
  lines.push(
    "",
    `| Share of no-match | ${census.repos.map((repo) => `\`${repo.id}\` (n=${byRepo(repo.id).length})`).join(" | ")} | All, weighted by no-match |`,
    `|---|${ids.map(() => "---:").join("|")}|---:|`,
  )
  for (const [label, counts] of SHARE_ROWS) {
    const test = (s) => counts(needsTypes(s), s.expected)
    const cells = ids.map((id) => {
      const sampled = byRepo(id)
      const hits = sampled.filter(test).length
      const { low, high } = wilsonInterval(hits, sampled.length)
      return `${percent(hits / sampled.length)} (${percent(low)}–${percent(high)})`
    })
    const { share, margin } = stratifiedShare(strataOf(census, test))
    lines.push(`| ${label} | ${cells.join(" | ")} | ${percent(share, 1)} ± ${percent(margin, 1)} |`)
  }
  lines.push("", "| Files | Samples | Resolver gap | Needs types |", "|---|---:|---:|---:|")
  for (const [label, inTests] of [
    ["Test files", true],
    ["Other files", false],
  ]) {
    const sampled = census.samples.filter((s) => s.test === inTests)
    const gap = sampled.filter((s) => !needsTypes(s)).length
    const share = (hits) =>
      sampled.length === 0 ? "–" : `${hits} (${percent(hits / sampled.length)})`
    lines.push(`| ${label} | ${sampled.length} | ${share(gap)} | ${share(sampled.length - gap)} |`)
  }
  return `${lines.join("\n")}\n`
}

export function landingOf(sample, sites) {
  const found = sites.get(callSiteKey(sample))
  if (found === undefined) return { outcome: "gone", resolved: null }
  if (found.resolved !== null) return { outcome: "resolved", resolved: found.resolved }
  return { outcome: found.bucket, resolved: null }
}

export function settles(sample, landing) {
  if (SETTLED_AS[sample.expected] !== landing.outcome) return false
  return sample.expected !== "edge" || landing.resolved === sample.expectedSymbol
}

export function tallyOutcomes(census, current) {
  const rows = new Map()
  for (const sample of census.samples) {
    const row = rows.get(sample.category) ?? {
      ...Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
      settled: 0,
    }
    const landing = landingOf(sample, current.get(sample.repo) ?? new Map())
    if (!OUTCOMES.includes(landing.outcome)) {
      throw new Error(
        `${where([sample])} lands in ${JSON.stringify(landing.outcome)}, which the census does ` +
          `not count; add it to OUTCOMES.`,
      )
    }
    row[landing.outcome]++
    if (settles(sample, landing)) row.settled++
    rows.set(sample.category, row)
  }
  return rows
}

export function renderResolution(baselines) {
  const share = (entry) =>
    `${entry.resolved} / ${entry.calls} (${percent(entry.resolved / entry.calls, 1)})`
  return [
    "| Repo | Resolved then | Resolved now |",
    "|---|---:|---:|",
    ...baselines.map(
      ({ recorded, now }) => `| \`${recorded.id}\` | ${share(recorded)} | ${share(now)} |`,
    ),
    "",
  ].join("\n")
}

export function renderCheck(census, current) {
  validateCensus(census)
  const rows = tallyOutcomes(census, current)
  const lines = [
    `| Category | Needs types | ${OUTCOMES.join(" | ")} | As expected |`,
    `|---|:--:|${OUTCOMES.map(() => "---:").join("|")}|---:|`,
  ]
  for (const [id, category] of Object.entries(census.categories)) {
    const row = rows.get(id)
    if (row === undefined) continue
    const total = OUTCOMES.reduce((sum, o) => sum + row[o], 0)
    lines.push(
      `| \`${id}\` | ${category.needsTypes ? "yes" : "no"} | ${OUTCOMES.map((o) => row[o]).join(" | ")} | ${row.settled} / ${total} |`,
    )
  }
  return `${lines.join("\n")}\n`
}

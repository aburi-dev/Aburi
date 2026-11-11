import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { dependency, fp, symbolAt, useScratchWorkspace, withCallsTo } from "@aburi/test-support"
import { type IR, SYMBOL_CHANGE_STATUSES, type SymbolChangeStatus } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME, EXIT, runDiff } from "../src"
import { diffDocuments, documentWith, documentWithCensus } from "./ir-documents"
import { runCliIn } from "./run-cli"
import { defaultOutput, writeIRs } from "./workspace"

const workspace = useScratchWorkspace("diff-filter")

const TOTAL = symbolAt("src/total.ts", "total", 1, { fingerprint: fp("total") })
const RETOTALLED = { ...TOTAL, fingerprint: { ...fp("total"), logic: "zzz000000000" } }
const LEGACY = symbolAt("src/legacy.ts", "legacy", 1)
const CHECKOUT = withCallsTo(symbolAt("src/checkout.ts", "checkout", 1), [RETOTALLED, 2])

/** `checkout` added and calling `total`, whose logic changed, and `legacy` removed. */
const BASE = documentWith({ symbols: [TOTAL, LEGACY] })
const CHECKOUT_CALLS_TOTAL = dependency({ from: CHECKOUT.id, to: TOTAL.id, via: "call" })
const HEAD = documentWith({ symbols: [CHECKOUT, RETOTALLED], dependencies: [CHECKOUT_CALLS_TOTAL] })

const STATUSES = SYMBOL_CHANGE_STATUSES.join(", ")

const read = (path: string | null) => readFile(path ?? "", "utf8")

/** The warnings that name `--filter`, apart from the census warning a hand-built IR draws. */
function aboutTheFilter(warnings: readonly string[]): string[] {
  return warnings.filter((line) => line.includes("--filter"))
}

async function cli(base: IR, head: IR, ...flags: string[]) {
  const paths = await writeIRs(workspace.root, base, head)
  const run = await runCliIn(workspace.root, [
    "diff",
    "--base",
    paths.base,
    "--head",
    paths.head,
    ...flags,
  ])
  const outputs = defaultOutput(workspace.root)
  return {
    ...run,
    markdown: await read(resolve(outputs, DIFF_MD_FILENAME)),
    json: await read(resolve(outputs, DIFF_JSON_FILENAME)),
  }
}

describe("aburi diff --filter", () => {
  it("narrows diff.md alone, and leaves diff.json and the glyph line whole", async () => {
    const { report: unfiltered } = await diffDocuments(workspace.root, BASE, HEAD)
    const everyChange = await read(unfiltered.diffJsonPath)

    const { report, warnings } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "added,removed",
    })

    expect(await read(report.diffMdPath)).toContain(
      "> ℹ **Only `added` and `removed` changes are listed.** 1 other Symbol change is left out of this report; the Summary counts it.",
    )
    expect(await read(report.diffJsonPath)).toBe(everyChange)
    expect(report.summaryLine).toBe(unfiltered.summaryLine)
    expect(report.summaryLine).toBe("+1 -1 ~1 ↔0 ⤴0")
    expect(aboutTheFilter(warnings)).toEqual([])
  })

  it("caps the filtered report, and writes it uncapped beside it", async () => {
    const { report: uncapped } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "changed",
    })
    const filtered = await read(uncapped.diffMdPath)

    const { report } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "changed",
      maxBytes: Buffer.byteLength(filtered, "utf8") - 1,
    })

    expect(await read(report.diffFullMdPath)).toBe(filtered)
    expect(await read(report.diffMdPath)).toContain("> ℹ **Only `changed` changes are listed.**")
  })

  it("caps over budget with the filter's note in what the cap cannot drop, and says so", async () => {
    const { warnings } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "changed",
      maxBytes: 10,
    })

    expect(warnings.join("\n")).toContain(
      "every section was dropped and the title, the summary and the filter's note alone exceed it.",
    )
  })

  it("leaves the gate counting every change, and says ahead of its lines that diff.md leaves them out", async () => {
    const { code, stderr } = await cli(BASE, HEAD, "--filter", "added", "--fail-on", "removed")

    expect(code).toBe(EXIT.GATE)
    const warning =
      "⚠ --filter leaves out of diff.md every change that tripped --fail-on removed (1 removed)."
    expect(stderr).toContain(warning)
    expect(stderr.indexOf(warning)).toBeLessThan(stderr.indexOf("--fail-on removed tripped"))
  })

  it.each([
    ["added", "removed", "every change that tripped --fail-on removed (1 removed)"],
    ["added", "removed:>0", "every change that tripped --fail-on removed:>0 (1 removed)"],
    [
      "added",
      "logic-changed,removed",
      "every change that tripped --fail-on logic-changed (1 changed)",
    ],
    ["removed", "unknown,added", "every change that tripped --fail-on added (1 added)"],
  ])(
    "under --filter %s, warns that diff.md leaves out what tripped --fail-on %s",
    async (filter, failOn, what) => {
      const { report, warnings } = await diffDocuments(workspace.root, BASE, HEAD, {
        filter,
        failOn,
      })

      expect(report.exitCode).toBe(EXIT.GATE)
      expect(aboutTheFilter(warnings)).toEqual([`⚠ --filter leaves out of diff.md ${what}.`])
    },
  )

  it.each([
    ["added,removed", "removed"],
    ["changed", "logic-changed"],
    ["added", "unknown"],
    ["added", "removed:>3"],
  ])("under --filter %s, warns of nothing for --fail-on %s", async (filter, failOn) => {
    const { warnings } = await diffDocuments(workspace.root, BASE, HEAD, { filter, failOn })

    expect(aboutTheFilter(warnings)).toEqual([])
  })

  it.each([
    ["", "it names no status"],
    [" , ", "it names no status"],
    ["added,", "segment 2 of 2 is empty"],
    ["added,,removed", "segment 2 of 3 is empty"],
    ["renamed", '"renamed" is no status.'],
    ["Added", '"Added" is no status.'],
    ["changed:foo", '"changed:foo" is no status.'],
    ["added:3", '"added:3" is no status.'],
    [
      "removed:duplicate",
      '"removed:duplicate" is a --fail-on clause, not a status; the report lists those changes under "removed".',
    ],
    [
      "dropped-toggled:to-kept",
      '"dropped-toggled:to-kept" is a --fail-on clause, not a status; the report lists those changes under "dropped-toggled".',
    ],
    [
      "added:>3",
      '"added:>3" is a --fail-on clause, not a status; the report lists those changes under "added".',
    ],
  ])("refuses %j before reading either IR", async (filter, reason) => {
    const absent = resolve(workspace.root, "absent.json")

    const refusal = runDiff({ cwd: workspace.root, base: absent, head: absent, filter })

    await expect(refusal).rejects.toMatchObject({ code: "input-error" })
    await expect(refusal).rejects.toThrowError(`--filter value "${filter}" is invalid: ${reason}`)
    await expect(refusal).rejects.toThrowError(`The statuses are ${STATUSES}.`)
  })

  it.each<[readonly string[], string, string]>([
    [[], "", "it names no status"],
    [["added", "renamed"], "added,renamed", '"renamed" is no status.'],
  ])("refuses the list %j as it refuses the value it joins into", async (list, shown, reason) => {
    const absent = resolve(workspace.root, "absent.json")
    const filter = list as readonly SymbolChangeStatus[]

    const refusal = runDiff({ cwd: workspace.root, base: absent, head: absent, filter })

    await expect(refusal).rejects.toThrowError(`--filter value "${shown}" is invalid: ${reason}`)
  })

  it("reads a list of statuses as the value that joins them", async () => {
    const { report: joined } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "added,removed",
    })
    const written = await read(joined.diffMdPath)

    const { report } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: ["removed", "added"],
    })

    expect(await read(report.diffMdPath)).toBe(written)
  })

  it("reads a status written twice, and spaces around the commas, as the statuses alone", async () => {
    const { report: plain } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "removed,added",
    })
    const once = await read(plain.diffMdPath)

    const { report } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: " added , removed,added ",
    })

    expect(await read(report.diffMdPath)).toBe(once)
  })

  it("warns that it has nothing to narrow under --format json, and of no tripped clause", async () => {
    const { report, warnings } = await diffDocuments(workspace.root, BASE, HEAD, {
      filter: "added",
      failOn: "removed",
      format: "json",
    })

    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.diffMdPath).toBeNull()
    expect(aboutTheFilter(warnings)).toEqual([
      "⚠ --filter has no effect under --format json: it narrows diff.md, which this run does not write, and diff.json holds every change.",
    ])
  })
})

describe("aburi diff --filter on the command line", () => {
  it("narrows the diff.md the command writes, and not the glyph line", async () => {
    const { code, stdout, markdown } = await cli(BASE, HEAD, "--filter", "removed")

    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout.split("\n")[0]).toBe("+1 -1 ~1 ↔0 ⤴0")
    expect(markdown).toContain("> ℹ **Only `removed` changes are listed.**")
  })

  it("refuses an empty value with exit 2, naming the statuses", async () => {
    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      "./b.json",
      "--head",
      "./h.json",
      "--filter",
      "",
    ])

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(`--filter value "" is invalid: it names no status`)
    expect(stderr).toContain(`The statuses are ${STATUSES}.`)
  })

  it("lists the flag and the statuses in `diff --help`", async () => {
    const { code, stdout } = await runCliIn(workspace.root, ["diff", "--help"])

    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout).toContain("--filter <statuses>")
    expect(stdout.replace(/\s+/g, " ")).toContain(STATUSES)
  })
})

describe("aburi diff --quiet", () => {
  const LOST: IR = documentWithCensus(
    {
      symbols: [CHECKOUT, RETOTALLED],
      dependencies: [CHECKOUT_CALLS_TOTAL],
      skipped: [{ path: "src/legacy.ts", reason: "parse-failed" }],
    },
    {
      totalCalls: 2,
      resolvedCalls: 1,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 1 },
    },
  )

  it("prints the glyph line alone, and changes no artefact, stderr line or exit code", async () => {
    const gate = ["--fail-on", "unknown"]
    const loud = await cli(BASE, LOST, ...gate)
    const quiet = await cli(BASE, LOST, ...gate, "--quiet")

    expect(loud.stdout.split("\n").slice(1, 3)).toEqual([
      "calls 2 · resolved 1 · unresolved 1 (no-match 1)",
      `→ ${defaultOutput(workspace.root, DIFF_MD_FILENAME)}`,
    ])
    expect(quiet.stdout).toBe(`${loud.stdout.split("\n")[0]}\n`)
    expect(quiet.stdout).toMatch(/^\+1 -0 ~1 ↔0 ⤴0 · \?1 unknown\n$/)
    expect(quiet.code).toBe(EXIT.GATE)
    expect(quiet.code).toBe(loud.code)
    expect(quiet.stderr).toBe(loud.stderr)
    expect(quiet.markdown).toBe(loud.markdown)
    expect(quiet.json).toBe(loud.json)
  })
})

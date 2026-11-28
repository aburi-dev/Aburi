import { resolve } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, runCli, runScan, type ScanOptions } from "../src"
import { capturedLog, MemStream, runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"

const workspace = useScratchWorkspace("scan-incident-sink")
const logged = capturedLog()

const REFUSAL = "parse reported a non-recoverable error at 12:4 — unterminated string"
const PARSE_FAILED_ADVICE =
  "the language plugin refused the source. Deterministic: fix the file, or the plugin."
const EXTRACTION_FAILED_ADVICE =
  "a plugin threw while extracting, its Symbols could not enter the Document, or the parser worker extracting it ended. This is the reason the run does not exit clean."

const FOUR_KINDS_OF_FILE = ["bad.stub", "boom.stub", "warn.stub", "ok.stub"]

const FOUR_KINDS_REPORTED = [
  "⚠ 1 file(s) had recoverable parse errors.",
  "    warn.stub: 2:1 — stray token",
  "⚠ 1 file(s) could not be parsed and were left out of the IR.",
  "⚠ 2 file(s) contributed no Symbols: parse-failed=1, extraction-failed=1",
  `⚠ parse-failed (1) — ${PARSE_FAILED_ADVICE}`,
  `    bad.stub: ${REFUSAL}`,
  `⚠ extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
  "    boom.stub: plugin exploded",
]

function scanStubs(incidents?: ScanOptions["incidents"]) {
  return runScan({
    cwd: workspace.root,
    log: logged.write,
    outputDir: resolve(workspace.root, "out"),
    format: "json",
    ...(incidents === undefined ? {} : { incidents }),
  })
}

async function incidentsOf(files: readonly string[], label?: string): Promise<readonly string[]> {
  await writeStubWorkspace(workspace.root, files)
  const log = recordingLogger()
  await scanStubs(label === undefined ? { warn: log.warn } : { warn: log.warn, label })
  return log.warnings
}

describe("runScan — LSP configuration the pass cannot act on", () => {
  async function lspIncidents(config: Record<string, unknown>, options: ScanOptions = {}) {
    await writeStubWorkspace(workspace.root, ["ok.stub"], config)
    const log = recordingLogger()
    const report = await runScan({
      cwd: workspace.root,
      log: logged.write,
      outputDir: resolve(workspace.root, "out"),
      format: "json",
      ...options,
      incidents: { warn: log.warn, label: "head" },
    })
    return { warnings: log.warnings, lspEnrichment: report.lspEnrichment }
  }

  it("reports a server key no loaded plugin has on the labelled incident channel", async () => {
    const { warnings } = await lspIncidents({
      lsp: { enabled: true, servers: { typescript: { command: "typescript-language-server" } } },
    })
    expect(warnings).toEqual([
      expect.stringMatching(
        /^⚠ head: No lsp\.servers key .*\(configured: typescript; loaded: stub\)/,
      ),
      expect.stringMatching(/^⚠ head: LSP enrichment is on/),
    ])
  })

  it.each<[string, Record<string, unknown>, ScanOptions]>([
    ["--lsp with no lsp block", {}, { lsp: true }],
    ["lsp.enabled with no servers block", { lsp: { enabled: true } }, {}],
    ["lsp.enabled with an empty servers block", { lsp: { enabled: true, servers: {} } }, {}],
  ])("records a run that started no server, and says so, for %s", async (_, config, options) => {
    const { warnings, lspEnrichment } = await lspIncidents(config, options)
    expect(warnings).toEqual([
      expect.stringMatching(/^⚠ head: No lsp\.servers key .*\(configured: none; loaded: stub\)/),
      expect.stringMatching(/^⚠ head: LSP enrichment is on, but .* so no LSP request was made\.$/),
    ])
    expect(lspEnrichment).toMatchObject({ enabled: false, requestsIssued: 0 })
  })
})

describe("runScan — files of a language no loaded plugin reads", () => {
  const PYTHON_FILES = Array.from({ length: 10 }, (_, i) => `ml/model${i}.py`)

  async function scanBeside(config: Record<string, unknown> = {}) {
    await writeStubWorkspace(workspace.root, ["ok.stub", ...PYTHON_FILES], config)
    const log = recordingLogger()
    const report = await scanStubs({ warn: log.warn })
    return { warnings: log.warnings, report }
  }

  it("names the Component and the language, and counts none of the files", async () => {
    const { warnings, report } = await scanBeside()

    expect(warnings).toEqual([
      `⚠ Component "stub-fixture" has files no loaded language plugin reads (10 py): none was scanned, and none counts in the IR's stats. Load a plugin for the language, or leave the files out with ignore.`,
    ])
    expect([report.totalFiles, report.skipped]).toEqual([1, []])
  })

  it("says nothing of files ignore leaves out", async () => {
    const { warnings } = await scanBeside({ ignore: ["ml/**"] })

    expect(warnings).toEqual([])
  })
})

describe("runScan — the incident report goes to the caller's sink", () => {
  it("emits the lines the scan command prints, in the same order", async () => {
    expect(await incidentsOf(FOUR_KINDS_OF_FILE)).toEqual(FOUR_KINDS_REPORTED)
  })

  it("returns the same report when no sink was given", async () => {
    await writeStubWorkspace(workspace.root, ["bad.stub", "boom.stub", "ok.stub"])
    const report = await scanStubs()
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.skipped).toHaveLength(2)
  })

  it("rejects with the exception its sink throws", async () => {
    await writeStubWorkspace(workspace.root, ["boom.stub", "ok.stub"])
    const boom = new Error("sink failed")
    await expect(
      scanStubs({
        warn: () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)
  })

  it("summarizes a file that reported more than one error, and says where recovery began", async () => {
    expect(await incidentsOf(["noisy.stub", "ok.stub"])).toEqual([
      "⚠ 1 file(s) had recoverable parse errors.",
      "    noisy.stub: 2 errors, first at 2:1 — stray token",
    ])
  })

  it("labels every line it owns, and leaves the per-file listing unlabelled", async () => {
    expect(await incidentsOf(["boom.stub", "ok.stub"], 'base ref "main"')).toEqual([
      '⚠ base ref "main": 1 file(s) contributed no Symbols: extraction-failed=1',
      `⚠ base ref "main": extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
      "    boom.stub: plugin exploded",
    ])
  })

  it("reports a file withdrawn for a duplicate Symbol id on the lines a throw reaches", async () => {
    expect(await incidentsOf(["ok.stub", "twin.stub"])).toEqual([
      "⚠ 1 file(s) contributed no Symbols: extraction-failed=1",
      `⚠ extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
      '    twin.stub: two Symbols share the id "stub:twin.stub#twin_stub" (lines 1 and 7); ' +
        "the language plugin gave two declarations one qualified name, and nothing it " +
        "reported separates them",
    ])
  })

  it("gates on a duplicate Symbol id and still writes the IR the surviving file produced", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub", "twin.stub"])
    const report = await scanStubs()
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.irPath).not.toBeNull()
    expect(report.keptSymbols).toBe(1)
    expect(report.extractionFailures.map((f) => [f.file, f.code])).toEqual([
      ["twin.stub", "duplicate-symbol-id"],
    ])
  })
})

describe("aburi scan — the incident report on stderr", () => {
  it("puts the whole report on stderr", async () => {
    await writeStubWorkspace(workspace.root, FOUR_KINDS_OF_FILE)
    const { code, stderr } = await runCliIn(workspace.root, [
      "scan",
      "--output-dir",
      resolve(workspace.root, "out"),
      "--format",
      "json",
    ])
    expect(code).toBe(EXIT.GATE)
    expect(stderr).toBe(
      [
        `warn: Skipped bad.stub: ${REFUSAL}`,
        "warn: Skipped boom.stub: extraction threw — plugin exploded",
        ...FOUR_KINDS_REPORTED,
      ]
        .map((line) => `${line}\n`)
        .join(""),
    )
  })

  it("puts the warnings above the summary they qualify, not below it", async () => {
    await writeStubWorkspace(workspace.root, ["boom.stub", "ok.stub"])
    const merged = new MemStream()
    await runCli({
      argv: ["scan", "--output-dir", resolve(workspace.root, "out"), "--format", "json"],
      stdout: merged,
      stderr: merged,
      env: {},
      cwd: workspace.root,
    })
    const lines = merged.text().trimEnd().split("\n")
    const summary = lines.findIndex((l) => l.includes("kept ·"))
    expect(lines.findIndex((l) => l.includes("contributed no Symbols"))).toBeLessThan(summary)
    expect(lines.findIndex((l) => l.includes("a plugin threw"))).toBeLessThan(summary)
  })
})

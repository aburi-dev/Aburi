import { noopRegistry, useScratchWorkspace } from "@aburi/test-support"
import type { LanguagePlugin } from "@aburi/types"
import { describe, expect, it, vi } from "vitest"
import {
  createFileExtractor,
  type FileExtraction,
  type ParsePoolFactory,
  type ScanProgress,
} from "../../src"
import { oneSymbolPerFile, scanStubs } from "../fixtures/plugins"

const workspace = useScratchWorkspace("scan-progress")

async function progressOf(
  files: readonly string[],
  language: LanguagePlugin = oneSymbolPerFile(),
): Promise<ScanProgress[]> {
  for (const name of files) await workspace.writeSource(name, name)
  const seen: ScanProgress[] = []
  await scanStubs(workspace.root, {
    languages: [language],
    onProgress: (progress) => seen.push(progress),
  })
  return seen
}

const extracting = (total: number) =>
  Array.from({ length: total + 1 }, (_, done) => ({ phase: "extracting", done, total }))

interface Gate {
  readonly opened: Promise<void>
  open(): void
}

function gate(): Gate {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/** A pool extracting on this thread that answers for file `fileId` once `gates[fileId]` opens. */
function gatedPool(
  gates: readonly Gate[],
  answers: Promise<FileExtraction>[],
  extract?: (fileId: number) => Promise<FileExtraction>,
): ParsePoolFactory {
  return (job) => {
    const extractor = createFileExtractor(job, {
      languages: [oneSymbolPerFile()],
      frameworks: [],
      effects: [],
      registry: noopRegistry,
    })
    return {
      extract: (fileId) => {
        const answer = (async () => {
          const extraction = await (extract ?? ((id) => extractor.extract(id)))(fileId)
          await gates[fileId]?.opened
          return extraction
        })()
        answers[fileId] = answer
        return answer
      },
      close: async () => {},
    }
  }
}

const lastCount = (seen: readonly ScanProgress[]): number | undefined =>
  seen.findLast((progress) => progress.phase === "extracting")?.done

describe("scan — progress", () => {
  it("reports each phase in order, counting the files extracted up to all of them", async () => {
    expect(await progressOf(["a.stub", "b.stub", "c.stub"])).toEqual([
      { phase: "discovering" },
      ...extracting(3),
      { phase: "resolving" },
    ])
  })

  it("counts a file whose extraction threw as done", async () => {
    const throwing = oneSymbolPerFile({
      parseFile: async (file) => {
        if (file.path === "boom.stub") throw new Error("stub parseFile exploded")
        return { tree: {}, errors: [], imports: [] }
      },
    })

    expect(await progressOf(["boom.stub", "ok.stub"], throwing)).toEqual([
      { phase: "discovering" },
      ...extracting(2),
      { phase: "resolving" },
    ])
  })

  it("reports the extraction of an empty workspace as done at once", async () => {
    expect(await progressOf([])).toEqual([
      { phase: "discovering" },
      { phase: "extracting", done: 0, total: 0 },
      { phase: "resolving" },
    ])
  })

  it("counts each file a parse pool finishes as it finishes, ahead of the files before it", async () => {
    const files = ["a.stub", "b.stub", "c.stub"]
    for (const name of files) await workspace.writeSource(name, name)
    const gates = files.map(gate)
    const seen: ScanProgress[] = []
    const scanned = scanStubs(workspace.root, {
      languages: [oneSymbolPerFile()],
      parsePool: gatedPool(gates, []),
      onProgress: (progress) => seen.push(progress),
    })

    for (const [opened, fileId] of [2, 1, 0].entries()) {
      gates[fileId]?.open()
      await vi.waitFor(() => expect(lastCount(seen)).toBe(opened + 1))
    }
    await scanned

    expect(seen).toEqual([{ phase: "discovering" }, ...extracting(3), { phase: "resolving" }])
  })

  it("counts no file a parse pool finishes after the scan has ended", async () => {
    for (const name of ["a.stub", "b.stub"]) await workspace.writeSource(name, name)
    const failure = new Error("the pool gave up")
    const late = gate()
    const answers: Promise<FileExtraction>[] = []
    const seen: ScanProgress[] = []
    const scanned = scanStubs(workspace.root, {
      languages: [oneSymbolPerFile()],
      parsePool: gatedPool([gate(), late], answers, async (fileId) => {
        if (fileId === 0) throw failure
        return { fileId, outcome: { kind: "crashed", detail: "never folded" }, events: [] }
      }),
      onProgress: (progress) => seen.push(progress),
    })

    await expect(scanned).rejects.toBe(failure)
    const before = [...seen]
    late.open()
    await answers[1]

    expect(seen).toEqual(before)
    expect(lastCount(seen)).toBe(0)
  })
})

import { noopRegistry, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it, vi } from "vitest"
import { createFileExtractor, type ParsePoolFactory } from "../../src"
import { oneSymbolPerFile, scanStubs } from "../fixtures/plugins"

const workspace = useScratchWorkspace("scan-abort")

const FILES = ["a.stub", "b.stub", "c.stub"]

/** A pool extracting on this thread that runs `before(fileId)` ahead of each file. */
function poolOnThisThread(before: (fileId: number) => void, close: () => Promise<void>) {
  const pool: ParsePoolFactory = (job) => {
    const extractor = createFileExtractor(job, {
      languages: [oneSymbolPerFile()],
      frameworks: [],
      effects: [],
      registry: noopRegistry,
    })
    return {
      extract: async (fileId) => {
        before(fileId)
        return extractor.extract(fileId)
      },
      close,
    }
  }
  return pool
}

describe("scan — an abort signal", () => {
  it("rejects with the signal's reason before it reads a file, once aborted", async () => {
    for (const name of FILES) await workspace.writeSource(name, name)
    const reason = new Error("the other scan failed")
    const parseFile = vi.fn(async () => ({ tree: {}, errors: [], imports: [] }))

    const scanned = scanStubs(workspace.root, {
      languages: [oneSymbolPerFile({ parseFile })],
      signal: AbortSignal.abort(reason),
    })

    await expect(scanned).rejects.toBe(reason)
    expect(parseFile).not.toHaveBeenCalled()
  })

  it("stops at the next file once aborted during one", async () => {
    for (const name of FILES) await workspace.writeSource(name, name)
    const reason = new Error("the other scan failed")
    const stop = new AbortController()
    const parsed: string[] = []

    const scanned = scanStubs(workspace.root, {
      languages: [
        oneSymbolPerFile({
          parseFile: async (file) => {
            parsed.push(file.path)
            if (file.path === "b.stub") stop.abort(reason)
            return { tree: {}, errors: [], imports: [] }
          },
        }),
      ],
      signal: stop.signal,
    })

    await expect(scanned).rejects.toBe(reason)
    expect(parsed).toEqual(["a.stub", "b.stub"])
  })

  it("rejects once aborted after its files are extracted, before it resolves their calls", async () => {
    for (const name of FILES) await workspace.writeSource(name, name)
    const reason = new Error("the other scan failed")
    const stop = new AbortController()

    const scanned = scanStubs(workspace.root, {
      languages: [oneSymbolPerFile()],
      onProgress: (progress) => {
        if (progress.phase === "resolving") stop.abort(reason)
      },
      signal: stop.signal,
    })

    await expect(scanned).rejects.toBe(reason)
  })

  it("stops folding a parse pool's files once aborted, and closes the pool", async () => {
    for (const name of FILES) await workspace.writeSource(name, name)
    const reason = new Error("the other scan failed")
    const stop = new AbortController()
    const close = vi.fn(async () => {})

    const scanned = scanStubs(workspace.root, {
      languages: [oneSymbolPerFile()],
      parsePool: poolOnThisThread((fileId) => {
        if (fileId === 0) stop.abort(reason)
      }, close),
      signal: stop.signal,
    })

    await expect(scanned).rejects.toBe(reason)
    expect(close).toHaveBeenCalledOnce()
  })
})

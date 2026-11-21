import { useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ParsePoolFactory } from "../../src"
import { oneSymbolPerFile, scanStubs } from "../fixtures/plugins"
import { makeServerConfig } from "../lsp/fixtures/enrichment-ctx"
import { documentSymbolServer } from "../lsp/fixtures/mock-server"

const workspace = useScratchWorkspace("scan-abort")

const FILES = ["a.stub", "b.stub", "c.stub"]
beforeEach(async () => {
  for (const name of FILES) await workspace.writeSource(name, name)
})

const reason = new Error("the other scan failed")

describe("scan — an abort signal", () => {
  it("rejects with the signal's reason before it looks for a file, once aborted", async () => {
    const parseFile = vi.fn(async () => ({ tree: {}, errors: [], imports: [] }))
    const onProgress = vi.fn()

    const scanned = scanStubs(workspace.root, {
      languages: [oneSymbolPerFile({ parseFile })],
      onProgress,
      signal: AbortSignal.abort(reason),
    })

    await expect(scanned).rejects.toBe(reason)
    expect(onProgress).not.toHaveBeenCalled()
    expect(parseFile).not.toHaveBeenCalled()
  })

  it("starts no parse pool once aborted while it discovers the files", async () => {
    const stop = new AbortController()
    const parsePool = vi.fn<ParsePoolFactory>(() => null)

    const scanned = scanStubs(workspace.root, {
      languages: [oneSymbolPerFile()],
      onProgress: (progress) => {
        if (progress.phase === "discovering") stop.abort(reason)
      },
      parsePool,
      signal: stop.signal,
    })

    await expect(scanned).rejects.toBe(reason)
    expect(parsePool).not.toHaveBeenCalled()
  })

  it("stops at the next file once aborted during one", async () => {
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

  it("asks its LSP server about no further file once aborted during one", async () => {
    const stop = new AbortController()
    const server = documentSymbolServer(() => {
      stop.abort(reason)
      return []
    })

    const scanned = scanStubs(workspace.root, {
      config: { lsp: { enabled: true, servers: { stub: makeServerConfig() } } },
      languages: [oneSymbolPerFile()],
      lspServerFactory: server,
      signal: stop.signal,
    })

    await expect(scanned).rejects.toBe(reason)
    expect(server.clients.get("stub")?.openFiles).toHaveLength(1)
  })

  it("rejects once aborted after its files are extracted, before it resolves their calls", async () => {
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
})

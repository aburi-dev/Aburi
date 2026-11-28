import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { extractFile } from "@aburi/test-harness"
import type { CandidateOverrides } from "@aburi/test-support"
import { makeExtractionCtx, makeCandidate as makeSharedCandidate } from "@aburi/test-support"
import type { FrameworkClassifyContext, SymbolCandidate } from "@aburi/types"

/** A context over a file that imports nothing. */
export function makeCtx(path = "src/a.tsx", content = ""): FrameworkClassifyContext {
  return { ...makeExtractionCtx(path, content), imports: [] }
}

export function makeCandidate(overrides: CandidateOverrides): SymbolCandidate<unknown> {
  return makeSharedCandidate(overrides, { filePath: "src/a.tsx" })
}

/** The Symbols the TypeScript plugin extracts from `source`, nodes and all, and their context. */
export function extracted(
  source: string,
  path = "src/f.tsx",
): Promise<{ candidates: SymbolCandidate<unknown>[]; ctx: FrameworkClassifyContext }> {
  return extractFile(langTypescriptPlugin, path, source)
}

/** The Symbol the TypeScript plugin extracts from `source` under `name`, nodes and all. */
export async function candidateNamed(
  source: string,
  name: string,
  path = "src/f.tsx",
): Promise<SymbolCandidate<unknown>> {
  return (await extractedNamed(source, name, path)).candidate
}

/** `candidateNamed`'s Symbol with the context it was extracted in, the file's imports included. */
export async function extractedNamed(
  source: string,
  name: string,
  path = "src/f.tsx",
): Promise<{ candidate: SymbolCandidate<unknown>; ctx: FrameworkClassifyContext }> {
  const { candidates, ctx } = await extracted(source, path)
  const found = candidates.find((candidate) => candidate.name === name)
  if (found === undefined) {
    throw new Error(`no Symbol named ${name}; have ${candidates.map((c) => c.name).join(", ")}`)
  }
  return { candidate: found, ctx }
}

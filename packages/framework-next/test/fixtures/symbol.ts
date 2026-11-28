import { makeCandidate, makeFrameworkCtx } from "@aburi/test-support"
import type { FrameworkClassifyContext, SymbolCandidate, SymbolKind } from "@aburi/types"

/** A context over `path`, of no Component, whose file imports nothing. */
export function makeCtx(path: string, content = ""): FrameworkClassifyContext {
  return makeFrameworkCtx({ path, content })
}

export interface SymbolShape {
  kind?: SymbolKind
  derivedBy?: string[]
}

/** A Symbol named `name` in `file`, a function unless `kind` says otherwise. */
export function symbolIn(
  file: string,
  name: string,
  { kind = "function", derivedBy = [] }: SymbolShape = {},
): SymbolCandidate<unknown> {
  return makeCandidate({
    kind,
    name,
    id: `ts:${file}#${name}`,
    source: { file, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
    derivedBy,
  })
}

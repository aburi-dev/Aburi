import type { CallCandidate, ClassifyContext, ImportEdge, OwnerSummary } from "@aburi/types"
import { symbolId } from "./ir"
import { noopRegistry } from "./registry"

export function makeCall(
  overrides: Partial<CallCandidate> & Pick<CallCandidate, "target">,
): CallCandidate {
  return {
    line: 1,
    argumentCount: 0,
    inAwait: false,
    inNew: false,
    literalArgs: [],
    ...overrides,
  }
}

// Past the lines `makeSymbol` gives a Symbol, so a test that has a declaration write its import
// says so with a line of its own.
const IMPORT_LINE = 100

/** A static import from `source`, binding nothing unless `overrides` say so. */
export function importEdge(
  overrides: Partial<ImportEdge> & Pick<ImportEdge, "source">,
): ImportEdge {
  return { symbols: [], line: IMPORT_LINE, dynamic: false, ...overrides }
}

/** `export { … } from source`, each name written `imported` or `imported as exported`. */
export function reexportEdge(source: string, ...names: string[]): ImportEdge {
  const entries = names.map((name) => {
    const [imported = name, exported = imported] = name.split(" as ")
    return { imported, exported }
  })
  return importEdge({ source, symbols: entries.map((entry) => entry.imported), reexports: entries })
}

/** `export * from source`. */
export function starReexportEdge(source: string): ImportEdge {
  return importEdge({ source, symbols: "*", reexportsAll: true })
}

/** `export * as exported from source`. */
export function namespaceReexportEdge(source: string, exported: string): ImportEdge {
  return importEdge({ source, symbols: "*", reexports: [{ imported: "*", exported }] })
}

function makeOwner(overrides: Partial<OwnerSummary> = {}): OwnerSummary {
  return {
    id: symbolId("ts:test.ts#Owner"),
    kind: "function",
    name: "Owner",
    extKind: null,
    decorators: [],
    component: null,
    ...overrides,
  }
}

export function makeCtx({
  imports = [],
  path = "src/service.ts",
  owner = makeOwner(),
  language = "ts",
}: {
  imports?: ImportEdge[]
  path?: string
  owner?: OwnerSummary
  language?: string
} = {}): ClassifyContext {
  return {
    owner,
    file: { path, imports },
    language,
    registry: noopRegistry,
    config: {},
  }
}

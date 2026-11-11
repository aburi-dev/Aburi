import type {
  ExtractionContext,
  LanguageCapabilities,
  SymbolCandidate,
  SymbolKind,
  Visibility,
  WrittenSourceRange,
} from "@aburi/types"
import { relativePath, symbolId, type WithLiteralFile } from "./ir"
import { noopRegistry } from "./registry"

/** A language that claims no feature, for a test plugin whose capabilities nothing reads. */
export const NO_LANGUAGE_CAPABILITIES: Readonly<LanguageCapabilities> = Object.freeze({
  hasDecorators: false,
  hasGenerics: false,
  hasAsync: false,
  hasMacros: false,
  hasPatternMatching: false,
  hasAbstractTypes: false,
  hasModules: false,
  hasNamespaces: false,
  hasTypeParameters: false,
  hasExplicitVisibility: false,
  hasJsDoc: false,
})

/** An `ExtractionContext` over one in-memory file, backed by `noopRegistry`. */
export function makeExtractionCtx(path = "src/a.ts", content = ""): ExtractionContext {
  return { file: { path: relativePath(path), content }, registry: noopRegistry, config: {} }
}

/** `id` and `source.file` are widened back to `string` so cases keep writing literals; the branding happens in `makeCandidate`, once. */
export type CandidateOverrides = Omit<Partial<SymbolCandidate<unknown>>, "id" | "source"> & {
  kind: SymbolKind
  id?: string
  source?: WithLiteralFile<WrittenSourceRange>
}

/** Per-suite defaults for the fields the framework fixtures disagreed on. */
export interface CandidateDefaults {
  visibility?: Visibility
  /** Default `source.file`, also the file half of the generated id. */
  filePath?: string
}

export function makeCandidate(
  overrides: CandidateOverrides,
  defaults: CandidateDefaults = {},
): SymbolCandidate<unknown> {
  const filePath = overrides.source?.file ?? defaults.filePath ?? "src/a.ts"
  const name = overrides.name ?? "Placeholder"
  return {
    id: symbolId(overrides.id ?? `ts:${filePath}#${name}`),
    kind: overrides.kind,
    extKind: overrides.extKind ?? null,
    name,
    visibility: overrides.visibility ?? defaults.visibility ?? "public",
    decorators: overrides.decorators ?? [],
    signature: overrides.signature ?? null,
    source: {
      ...(overrides.source ?? { startLine: 1, endLine: 1, startColumn: null, endColumn: null }),
      file: relativePath(filePath),
    },
    derivedBy: overrides.derivedBy ?? [],
    bodyNode: overrides.bodyNode ?? null,
    ...(overrides.mergedDeclarations === undefined
      ? {}
      : { mergedDeclarations: overrides.mergedDeclarations }),
    fullNode: overrides.fullNode ?? { placeholder: true },
  }
}

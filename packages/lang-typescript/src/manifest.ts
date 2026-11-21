import { type LangManifest, PLUGIN_SCHEMA_URL } from "@aburi/types"
import grammars from "@vscode/tree-sitter-wasm/package.json" with { type: "json" }
import { TYPESCRIPT_LANGUAGE_ID } from "./qname"

export const langTypescriptManifest: LangManifest = {
  $schema: PLUGIN_SCHEMA_URL,
  name: "lang-typescript",
  version: "0.0.0",
  type: "lang",
  languageId: TYPESCRIPT_LANGUAGE_ID,
  // The build copies the .wasm grammars from this package, so the package's version names them
  // exactly. Kept a devDependency, the package is inlined here rather than imported at run time.
  grammarRevision: `${grammars.name}@${grammars.version}`,
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [
      "export-keyword",
      "export-default",
      "export-clause",
      "variable-assigned-function",
      "variable-assigned-class",
      "class-method",
      "field-assigned-function",
      "call-statement",
      "chained-call",
      "path-literal",
      "argument-names",
      "inline-handler",
      "call-argument-function",
      "invoked-function",
      "module-scope",
      "object-literal-initializer",
      "object-method",
      "property-assigned-function",
      "static-method",
      "interface-declaration",
      "type-alias",
      "namespace-declaration",
      "enum-declaration",
      "constructor-declaration",
      "destructured-binding",
      "accessor-declaration",
      "abstract-declaration",
      "ambient-declaration",
      "declaration-merged",
    ],
    frameworks: [],
  },
  capabilities: {
    wasmHeapPerWorkerMB: 256,
  },
}

# @aburi/types

Shared TypeScript types for the Aburi ecosystem. Two flavours:

- **Schema-generated** types for the four public JSON Schemas — `aburi.ir.v1`,
  `aburi.config.v1`, `aburi.diff.v1`, `aburi.plugin.v1`. Regenerated from
  `schema/*.json` via `pnpm --filter @aburi/types codegen`; the schema is the
  source of truth, the TypeScript is a mechanical projection.
- **Hand-written** plugin interfaces (`LanguagePlugin`, `FrameworkPlugin`,
  `EffectPlugin`, `VocabRegistry`, `SymbolCandidate`, `ExtractionContext`, …)
  that the schemas cannot express — richer generic and function signatures that
  make the plugin contracts type-safe.

Every other `@aburi/*` package depends on this one. Its runtime code is a few
constants and small helpers, among them the `$schema` URL each kind of document
is written with (`IR_SCHEMA_URL`, `DIFF_SCHEMA_URL`, `CONFIG_SCHEMA_URL`,
`PLUGIN_SCHEMA_URL`) and `isIRSchemaURL`, which accepts every `$schema` an IR v1
may carry: the `aburi.dev` URL and the `aburi.kage1020.com` one the schemas were
served from before.

## Install

```bash
pnpm add @aburi/types
```

## Usage

```ts
import type { IR, Symbol as IRSymbol, DiffResult, Config } from "@aburi/types"
import type { LanguagePlugin, FrameworkPlugin, EffectPlugin } from "@aburi/types"
import { PLUGIN_SCHEMA_URL } from "@aburi/types"
```

## Regenerating from schema

```bash
pnpm --filter @aburi/types codegen
# → src/generated/{ir,config,diff,plugin}.ts (do not hand-edit)
```

Note: `src/generated/plugin.ts` is singular (schema-generated). The
hand-written plugin interfaces live at `src/plugins.ts` (plural). Keeping the
two clearly separated means a re-run of codegen never clobbers the interfaces
that the schemas cannot express.

## See also

- [`schema/`](../../schema) — the JSON Schemas this package projects.
- [`docs/design/ir-schema.md`](../../docs/design/ir-schema.md) — IR contract.
- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — plugin interface.

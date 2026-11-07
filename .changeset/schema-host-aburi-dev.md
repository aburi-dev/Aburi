---
"@aburi/types": minor
"@aburi/config": minor
"@aburi/core": minor
"@aburi/diff": minor
"@aburi/cli": minor
"@aburi/plugin-registry": minor
"@aburi/lang-typescript": minor
"@aburi/framework-express": minor
"@aburi/framework-nestjs": minor
"@aburi/framework-next": minor
"@aburi/framework-react": minor
"@aburi/framework-trpc": minor
"@aburi/effects-drizzle": minor
"@aburi/effects-nest": minor
"@aburi/effects-prisma": minor
"@aburi/effects-trpc": minor
"@aburi/github-action": patch
---

Move the documentation site and the JSON Schemas to `aburi.dev`

The four schemas now identify themselves as `https://aburi.dev/schema/...`, and that is the `$schema` an IR, a diff, an `aburi init` config and every bundled plugin manifest carries. The site, including the schemas under `/schema/`, is served from `https://aburi.dev`.

Nothing written before has to change. Each schema's `$schema` now accepts the `aburi.kage1020.com` URL it carried until now beside the `aburi.dev` one, so an existing `aburi.json`, a plugin manifest naming the former host, and a committed IR all stay valid v1: `aburi diff` and `aburi explain` read such an IR, and a base and head that differ only in which host they name are diffed as one schema version. The former host keeps answering, so an editor resolving an old `$schema` line still finds the schema.

`@aburi/types` exports the URLs Aburi writes — `IR_SCHEMA_URL`, `DIFF_SCHEMA_URL`, `CONFIG_SCHEMA_URL`, `PLUGIN_SCHEMA_URL` — and `isIRSchemaURL`, which accepts every `$schema` the IR schema does. The generated `$schema` types widen to the two values each schema accepts.

An earlier `@aburi/cli` accepts only the former host, so it refuses everything this release writes: the `aburi.json` that `aburi init` writes (or one whose `$schema` line follows the docs) fails with `config-invalid` at exit 2, an IR from `aburi scan` is refused by `aburi diff <files>` and `aburi explain`, and a plugin from this release fails to load. Upgrade the CLI first — including a GitHub Action `version:` pinned to an earlier one — and then the configs and plugins.

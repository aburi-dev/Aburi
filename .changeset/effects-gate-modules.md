---
"@aburi/effects-prisma": minor
"@aburi/effects-drizzle": minor
"@aburi/effects-nest": minor
"@aburi/effects-trpc": minor
---

Each effects plugin exports the packages its import gate opens on: `PRISMA_CLIENT_MODULES_LIST`, `DRIZZLE_MODULES_LIST`, `NEST_EMITTER_MODULES_LIST` (beside `NEST_CQRS_MODULE`) and `TRPC_CLIENT_MODULES_LIST`. `aburi init` writes the plugin for a dependency on any of them.

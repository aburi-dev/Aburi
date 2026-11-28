---
"@aburi/cli": minor
---

`aburi init` now writes `effects`, as it writes `languages` and `frameworks`: `effects-prisma` for a dependency on `@prisma/client`, `effects-drizzle` for `drizzle-orm`, `effects-nest` for `@nestjs/event-emitter`, `eventemitter2` or `@nestjs/cqrs`, and `effects-trpc` for `@trpc/client`, `@trpc/react-query` or `@trpc/next`, in any dependency field of the manifests at the workspace root and at each Component's root, a manifest that opens with a byte order mark included. Its summary gains an `effects:` line, and `--with-suggestions` names the effects plugins that are not installed after the language and framework ones. Following the guides used to leave every effect out of the IR until `effects` was written by hand.

`aburi scan` now warns when the config declares `components` and a workspace package it leaves out gave the IR Symbols, naming each package and how many Symbols count towards no Component, and the three ways out: add it to the list, leave its files out with `ignore`, or remove `components`. A list `aburi init` wrote used to stop covering a package added later without a word. A package whose files `ignore` leaves out is not named, and neither is one a declared root lies inside, since declaring part of it leaves the rest out on purpose.

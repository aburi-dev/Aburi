---
"@aburi/framework-nestjs": minor
"@aburi/core": minor
"@aburi/types": patch
"@aburi/cli": patch
---

Refuse a decorator the scan traced to a package outside the workspace that is not NestJS's, instead of classifying it at `medium`. **Behaviour change:** a class decorated `@Controller()` from `routing-controllers`, `@tsed/common` or any other package outside the `@nestjs/` scope is no longer a `framework:nestjs:controller`, and the same holds for a route, handler, module or provider decorator. This applies whether the decorator is imported by name, renamed, as a default import, through a namespace import, through a workspace barrel that re-exports it, or through a path alias that maps to no workspace file. A NestJS decorator on the same class or method still classifies. A decorator that may still be NestJS's is graded `medium` as before. That covers a barrel reaching the name only through `export *`, a workspace package imported by its name through the package manager's links, and a chain the scan could not follow.

`ImportEdge.origins` now holds a key only for a name whose chain ended at a package outside the workspace, one that is neither a workspace file nor a workspace package. The key is recorded even when that package is the edge's own specifier, so `import { Controller } from "routing-controllers"` maps `Controller` to `routing-controllers`. A workspace package's name, or a path under it, ends the chain with no key, where it used to be recorded as an origin. The scan reads the package names from `ScanInput.workspacePackages`, and `ExtractionJob` carries them to every extractor as `workspacePackageNames`. `aburi scan` now lists every workspace package there, not only those a Component holds. It passes over a manifest it cannot read when no Component holds that manifest.

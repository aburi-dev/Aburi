---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/markdown-projection": minor
---

Mark the Symbols of a generated file with `inGeneratedFile: true`, and count their calls apart. A file is generated when the comments it opens with say so: the `@generated` tag, a file or code said to be (auto-)generated, or `generated` beside `do not edit`. Such a file is scanned as before, its calls resolved and its effects propagated, but `stats.callResolution.generated` holds the census of its calls, and the census line `aburi scan` and `aburi diff` print counts the authored code and ends with the generated files' calls. `aburi diff` reports the changes of generated files on one line, in a last `⚙ Generated files` section, with their edges, instead of in the sections above it, and the Summary line counts them as `· N in generated files`.

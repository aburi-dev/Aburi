---
"@aburi/lang-typescript": patch
---

Parse two forms the vendored grammar has no rule for without reporting a syntax error. A generic call signature that opens a line below another member with no separator between them (`(): A` above `<U>(u: U): U` in an object type or an interface, the way overloaded call signatures are commonly written) was read as the type arguments of the member above, which broke the type and, in a file of such declarations, every declaration after it: hono's `src/types.ts` reported 848 errors and kept none of its later Symbols. The file is now parsed a second time with a separator in that place, as `tsc` reads it; the signature has to be indented, and one written at the start of its line still reports. TypeScript 5.0's `export type * from` and `export type * as ns from` no longer report an error either, and their edge exports no value. On the public-repository benchmark the files with recoverable parse errors go from 24 to 10.

A Symbol in such a file can change its range, kind and fingerprints once, as it is now read whole, so an `aburi diff` against an IR an earlier version wrote reports it as changed.

---
"@aburi/framework-next": minor
---

An App Router file is now one under the `app/` or `src/app/` directly at its Component's root (or
under the App Router directory the Component lies in), outside private `_folders`. An `app`
directory anywhere else, such as a package named `app` (`apps/app/components/loading.tsx`), no
longer makes a file a page, loading UI or error boundary. `recognizeAppRouterFile` takes the
project's root as a second argument.

New extKinds: `framework:next:server-action`, for what a `"use server"` module exports at any
path, and `framework:next:middleware`, for the `middleware` (or Next.js 16 `proxy`) export or the
default export of `middleware.ts` / `proxy.ts` beside `app/`. `recognizeMiddlewareFile` is
exported.

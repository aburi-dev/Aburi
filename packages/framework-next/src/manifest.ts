import { type FrameworkManifest, PLUGIN_SCHEMA_URL } from "@aburi/types"

export const NEXT_DERIVED_BY_PREFIX = "framework:next"

export const frameworkNextManifest: FrameworkManifest = {
  $schema: PLUGIN_SCHEMA_URL,
  name: "framework-next",
  version: "0.0.0",
  type: "framework",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [
      {
        id: "framework:next:page",
        baseKind: "function",
        description:
          "Next.js App Router page component — the default export of app/**/page.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:layout",
        baseKind: "function",
        description:
          "Next.js App Router layout component — the default export of app/**/layout.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:template",
        baseKind: "function",
        description:
          "Next.js App Router template — the default export of app/**/template.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:loading",
        baseKind: "function",
        description:
          "Next.js App Router loading UI — the default export of app/**/loading.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:error",
        baseKind: "function",
        description:
          "Next.js App Router error boundary — the default export of app/**/error.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:not-found",
        baseKind: "function",
        description:
          "Next.js App Router not-found UI — the default export of app/**/not-found.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:route",
        baseKind: "function",
        description:
          "Next.js App Router route handler — what app/**/route.{ts,tsx,js,jsx} exports under an HTTP verb name (GET / POST / PUT / DELETE / PATCH / OPTIONS / HEAD). Its kind is const where the language plugin cannot see the value is a function (export const { GET, POST } = handlers).",
      },
      {
        id: "framework:next:middleware",
        baseKind: "function",
        description:
          "Next.js middleware — the middleware export, or the default export, of middleware.{ts,tsx,js,jsx} beside app/; the proxy export of proxy.{ts,tsx,js,jsx} from Next.js 16.",
      },
      {
        id: "framework:next:server-action",
        baseKind: "function",
        description:
          'Next.js server action — an exported async function, or a const a call handed a function initialises, of a module whose first statement is "use server", at any path.',
      },
    ],
    extKindPrefixes: ["framework:next"],
    derivedByPrefixes: [NEXT_DERIVED_BY_PREFIX],
    // Matches the identifier `@aburi/core`'s Component autodetect uses for the `next` dependency.
    frameworks: ["nextjs"],
    // Each throws on every call. `forbidden` and `unauthorized` answer 403 and 401 only under
    // `experimental.authInterrupts`, and throw a plain error without it.
    exitCalls: [
      {
        module: "next/navigation",
        exports: ["redirect", "permanentRedirect", "notFound", "forbidden", "unauthorized"],
      },
    ],
  },
}

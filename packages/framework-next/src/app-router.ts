export type AppRouterRole =
  | "page"
  | "layout"
  | "template"
  | "loading"
  | "error"
  | "not-found"
  | "route"

export const NEXT_APP_ROUTER_ROLES: ReadonlyMap<string, AppRouterRole> = new Map([
  ["page", "page"],
  ["layout", "layout"],
  ["template", "template"],
  ["loading", "loading"],
  ["error", "error"],
  ["not-found", "not-found"],
  ["route", "route"],
])

// Next.js matches every App Router file, `route` included, against `pageExtensions`, whose
// default holds all four: an Open Graph `route.tsx` renders JSX into an `ImageResponse`.
const NEXT_APP_ROUTER_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".jsx"])

export type AppRouterFile = { readonly role: AppRouterRole }

export function recognizeAppRouterFile(path: string): AppRouterFile | null {
  const segments = path.split("/")
  const lastSegment = segments.at(-1)
  if (lastSegment === undefined) return null

  const dot = lastSegment.lastIndexOf(".")
  if (dot < 0) return null
  // The base name stays case-sensitive: the runtime treats `Page.tsx` as a colocated component.
  const ext = lastSegment.slice(dot).toLowerCase()
  const base = lastSegment.slice(0, dot)

  const role = NEXT_APP_ROUTER_ROLES.get(base)
  if (role === undefined) return null

  if (!NEXT_APP_ROUTER_EXTENSIONS.has(ext)) return null

  // Any `app` parent counts: monorepos routinely nest it (`apps/web/app/page.tsx`).
  const parents = segments.slice(0, -1)
  if (!parents.includes("app")) return null

  return { role }
}

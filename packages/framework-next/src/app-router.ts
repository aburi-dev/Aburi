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

const NEXT_APP_ROUTER_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".jsx"])

export type AppRouterFile = { readonly role: AppRouterRole }

/**
 * A file of the App Router: a special file name under the `app/` or `src/app/` of the Next.js
 * project at `root`, the workspace-relative directory of the file's Component (`.` for the
 * workspace root), or under the App Router directory `root` itself lies in.
 */
export function recognizeAppRouterFile(path: string, root = "."): AppRouterFile | null {
  const segments = path.split("/")
  const rootSegments = withinRoot(segments, root)
  if (rootSegments === null) return null
  const name = specialFileName(segments.at(-1))
  if (name === null) return null
  const role = NEXT_APP_ROUTER_ROLES.get(name)
  if (role === undefined) return null

  const start = routingStart(segments, rootSegments)
  if (start === null) return null
  // A `_folder` opts itself and everything under it out of routing; `%5F` is a routed `_`.
  if (segments.slice(start, -1).some((directory) => directory.startsWith("_"))) return null
  return { role }
}

/** What Next.js runs ahead of every matched request, and the export it calls there. */
export type MiddlewareFile = { readonly export: "middleware" | "proxy" }

/**
 * `middleware.{ts,tsx,js,jsx}`, or `proxy` as Next.js 16 renames it, beside `app/` in the
 * Next.js project at `root`: directly in the project directory or in its `src/`.
 */
export function recognizeMiddlewareFile(path: string, root = "."): MiddlewareFile | null {
  const segments = path.split("/")
  const rootSegments = withinRoot(segments, root)
  if (rootSegments === null) return null
  const name = specialFileName(segments.at(-1))
  if (name !== "middleware" && name !== "proxy") return null
  const directories = segments.slice(rootSegments.length, -1)
  if (directories.length === 0 || (directories.length === 1 && directories[0] === "src")) {
    return { export: name }
  }
  return null
}

/** `root`'s segments, when `segments` lie under it. */
function withinRoot(segments: readonly string[], root: string): readonly string[] | null {
  if (root === ".") return []
  const rootSegments = root.split("/")
  return rootSegments.every((segment, index) => segments[index] === segment) ? rootSegments : null
}

/** Where the routed directories begin in `segments`, which lie under `rootSegments`. */
function routingStart(segments: readonly string[], rootSegments: readonly string[]): number | null {
  // A root ending in `app` names the project, as a package called `app` does.
  const inner = rootSegments.slice(0, -1).lastIndexOf("app")
  if (inner >= 0) return inner + 1
  const base = rootSegments.length
  if (segments[base] === "app") return base + 1
  if (segments[base] === "src" && segments[base + 1] === "app") return base + 2
  return null
}

function specialFileName(lastSegment: string | undefined): string | null {
  if (lastSegment === undefined) return null
  const dot = lastSegment.lastIndexOf(".")
  if (dot < 0) return null
  // The base name stays case-sensitive: the runtime treats `Page.tsx` as a colocated component.
  const ext = lastSegment.slice(dot).toLowerCase()
  return NEXT_APP_ROUTER_EXTENSIONS.has(ext) ? lastSegment.slice(0, dot) : null
}

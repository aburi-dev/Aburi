import { describe, expect, it } from "vitest"
import { recognizeAppRouterFile, recognizeMiddlewareFile } from "../src/index"

describe("recognizeAppRouterFile", () => {
  it.each([
    ["app/page.tsx", ".", "page"],
    ["app/dashboard/page.tsx", ".", "page"],
    ["src/app/dashboard/page.tsx", ".", "page"],
    ["apps/web/app/(marketing)/pricing/page.tsx", "apps/web", "page"],
    ["packages/web/src/app/dashboard/page.jsx", "packages/web", "page"],
    ["apps/app/app/page.tsx", "apps/app", "page"],
    ["apps/shop/src/app/checkout/pay/page.tsx", "apps/shop/src/app/checkout", "page"],
    ["apps/shop/app/(store)/cart/page.tsx", "apps/shop/app/(store)", "page"],
    ["app/%5Fstyle/page.tsx", ".", "page"],
    ["app/@modal/(.)photo/page.tsx", ".", "page"],
    ["app/dashboard/settings/layout.tsx", ".", "layout"],
    ["app/template.tsx", ".", "template"],
    ["app/loading.tsx", ".", "loading"],
    ["app/error.tsx", ".", "error"],
    ["app/not-found.tsx", ".", "not-found"],
    ["app/api/users/route.ts", ".", "route"],
    ["app/api/route.js", ".", "route"],
    ["app/api/og/route.tsx", ".", "route"],
    ["app/api/og/route.jsx", ".", "route"],
  ])("recognizes %s under the project at %s as a %s", (path, root, role) => {
    expect(recognizeAppRouterFile(path, root)).toEqual({ role })
  })

  it.each([
    ["src/page.tsx", ".", "no app/ directory"],
    ["apps/foo/page.tsx", ".", "`apps` is not `app`"],
    ["app-config/page.tsx", ".", "`app-config` is not `app`"],
    ["apps/web/app/page.tsx", ".", "an `app` below the project directory"],
    ["apps/app/components/loading.tsx", "apps/app", "a project directory named `app`"],
    ["lib/app/page.tsx", ".", "an `app` below another directory"],
    ["src/lib/app/page.tsx", ".", "an `app` below `src/lib`"],
    ["packages/web/app/page.tsx", "apps/web", "a file outside the project directory"],
    ["app/components/loading.tsx", "app", "a project directory named `app` at the top"],
    [
      "apps/shop/app/_internal/page.tsx",
      "apps/shop/app/_internal",
      "a Component inside a private folder",
    ],
    ["app/_components/error.tsx", ".", "a private folder"],
    ["src/app/dashboard/_lib/route.ts", ".", "a folder below a private one"],
    ["src/lib/utils.ts", ".", "not a special file name"],
    ["app/default.tsx", ".", "a special file not covered"],
    ["app/global-error.tsx", ".", "a special file not covered"],
    ["app/Page.tsx", ".", "the base name is case-sensitive"],
    ["app/Layout.tsx", ".", "the base name is case-sensitive"],
    ["app/lib/page.ts.bak", ".", "an unrecognized extension"],
    ["app/page.mdx", ".", "an unrecognized extension"],
    ["src/page.py", ".", "an unrecognized extension"],
    ["app\\dashboard\\page.tsx", ".", "separated by backslashes"],
    ["app/page", ".", "no extension"],
    ["app/", ".", "no file name"],
    ["", ".", "empty"],
  ])("returns null for %j under the project at %s — %s", (path, root) => {
    expect(recognizeAppRouterFile(path, root)).toBeNull()
  })
})

describe("recognizeMiddlewareFile", () => {
  it.each([
    ["middleware.ts", ".", "middleware"],
    ["src/middleware.js", ".", "middleware"],
    ["proxy.ts", ".", "proxy"],
    ["apps/web/src/proxy.tsx", "apps/web", "proxy"],
  ])("recognizes %s under the project at %s, exporting %s", (path, root, name) => {
    expect(recognizeMiddlewareFile(path, root)).toEqual({ export: name })
  })

  it.each([
    ["lib/middleware.ts", "."],
    ["app/middleware.ts", "."],
    ["apps/web/middleware.ts", "."],
    ["Middleware.ts", "."],
    ["middleware.mjs", "."],
    ["src/auth/proxy.ts", "."],
  ])("returns null for %s under the project at %s", (path, root) => {
    expect(recognizeMiddlewareFile(path, root)).toBeNull()
  })
})

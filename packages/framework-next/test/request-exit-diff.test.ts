import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffOfEditWith, scanWith } from "@aburi/test-harness"
import { onlyChange, symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { nextFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("request-exit")

const PAGE = "app/admin/page.tsx"
const PAGE_ID = "ts:app/admin/page.tsx#AdminPage"

const lineup = { languages: [langTypescriptPlugin], frameworks: [nextFrameworkPlugin] }

const page = (...checks: string[]) =>
  [
    'import { forbidden, notFound, permanentRedirect, redirect, unauthorized } from "next/navigation"',
    "export default async function AdminPage({ params }: { params: { id: string } }) {",
    "  const session = await auth()",
    ...checks,
    "  const report = await loadReport(params.id)",
    "  return <Dashboard user={session.user} report={report} />",
    "}",
    "",
  ].join("\n")

const CHECKS = [
  '  if (!session) redirect("/login")',
  '  if (session.expired) permanentRedirect("/renew")',
  "  if (!session.user) unauthorized()",
  "  if (!session.user.isAdmin) forbidden()",
  "  if (!params.id) notFound()",
]

describe("a call that ends a Next.js request", () => {
  it("makes each `if` around one a guard", async () => {
    await workspace.writeSource(PAGE, page(...CHECKS))
    const scanned = await scanWith(workspace.root, lineup)

    const guards = symbolById(scanned, PAGE_ID).rules.filter((rule) => rule.type === "guard")
    expect(guards.map((rule) => rule.condition)).toEqual([
      "!session",
      "session.expired",
      "!session.user",
      "!session.user.isAdmin",
      "!params.id",
    ])
  })

  it("reports removing the checks as a logic change", async () => {
    const { diff } = await diffOfEditWith(workspace, lineup, PAGE, page(...CHECKS), page())

    const change = onlyChange(diff)
    expect(change.after).toMatchObject({ id: PAGE_ID, extKind: "framework:next:page" })
    expect(change.delta).toMatchObject({ logicChanged: true, apiChanged: false })
  })
})

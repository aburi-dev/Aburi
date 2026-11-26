import { nextFrameworkPlugin } from "@aburi/framework-next"
import { reactFrameworkPlugin } from "@aburi/framework-react"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"

const workspace = useScratchWorkspace("next-route-handler")

// The order `aburi init` writes. The first framework plugin to classify a Symbol wins, and
// framework-react alone would file a capitalised function that renders JSX as a component.
const lineup = {
  languages: [langTypescriptPlugin],
  frameworks: [nextFrameworkPlugin, reactFrameworkPlugin],
}

describe("scan — a Next.js route handler that renders JSX, beside framework-react", () => {
  it("classifies the handler as a route and the component it renders as a component", async () => {
    await workspace.writeSource(
      "app/api/og/route.tsx",
      [
        'import { ImageResponse } from "next/og"',
        'import { Card } from "../../../components/card"',
        "",
        "export async function GET() {",
        '  return new ImageResponse(<Card title="Hello" />, { width: 1200, height: 630 })',
        "}",
        "",
      ].join("\n"),
    )
    await workspace.writeSource(
      "components/card.tsx",
      [
        "export function Card({ title }: { title: string }) {",
        "  return <div>{title}</div>",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWith(workspace.root, lineup)
    const handler = symbolById(result, "ts:app/api/og/route.tsx#GET")

    expect(handler.extKind).toBe("framework:next:route")
    expect(handler.derivedBy).toContain("framework:next:route:GET")
    expect(symbolById(result, "ts:components/card.tsx#Card").extKind).toBe(
      "framework:react:component",
    )
  })
})

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export interface ShowcaseEntry {
  slug: string
  title: string
  summary: string
}

/** The pages `@aburi/examples` rendered at build time; build that package first. */
export function readShowcase(): ShowcaseEntry[] {
  return JSON.parse(readFileSync(showcaseFile("showcase.json"), "utf8")) as ShowcaseEntry[]
}

export function readShowcasePage(slug: string): string {
  return readFileSync(showcaseFile(`${slug}.md`), "utf8")
}

// Plain Markdown rather than a template loop, so the Markdown copy of the page lists every example
// too; absolute links, because that copy is also served from `/showcase.md`.
export function showcaseIndexPage(): string {
  const entries = readShowcase().map(
    ({ slug, title, summary }) => `## [${title}](/showcase/${slug})\n\n${summary}`,
  )
  return [
    "# Showcase",
    `Each example is a small project written twice, before and after one change. When this site is built, both
versions are committed to a scratch repository and \`aburi diff HEAD~1..HEAD\` runs over them, so every page
shows the change as git sees it next to the report Aburi actually prints for it — not a mock-up.`,
    ...entries,
  ].join("\n\n")
}

function showcaseFile(name: string): string {
  try {
    return require.resolve(`@aburi/examples/showcase/${name}`)
  } catch (cause) {
    throw new Error(
      `@aburi/examples has not rendered ${name}. Run \`pnpm turbo run build --filter=@aburi/docs^...\` first.`,
      { cause },
    )
  }
}

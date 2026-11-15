// Fails the build when a built page has no Markdown copy for the Worker to serve, or a copy with
// nothing but its title, or one still holding the Vue template it was rendered from.
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".vitepress", "dist")

const pages = (await readdir(DIST, { recursive: true }))
  .map((path) => path.replaceAll("\\", "/"))
  .filter((path) => path.endsWith(".html") && path !== "404.html")

function twinOf(page) {
  if (page === "index.html") return "llms.txt"
  return `${page.replace(/\/index\.html$/, "").replace(/\.html$/, "")}.md`
}

async function problemWith(twin) {
  let text
  try {
    text = await readFile(join(DIST, twin), "utf8")
  } catch {
    return "is missing"
  }
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "")
  if (!body.split("\n").some((line) => line.trim() !== "" && !line.startsWith("#"))) {
    return "has no content beyond its title"
  }
  if (/<script\s+setup|\sv-(?:for|if)=/.test(body)) return "still holds a Vue template"
  return undefined
}

const problems = []
for (const page of pages) {
  const twin = twinOf(page)
  const problem = await problemWith(twin)
  if (problem) problems.push(`${page}: its Markdown copy ${twin} ${problem}`)
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log(`${pages.length} pages, each with a Markdown copy in ${relative(process.cwd(), DIST)}`)

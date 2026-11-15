export interface Assets {
  fetch(request: Request): Promise<Response>
}

export interface Env {
  ASSETS: Assets
}

const MARKDOWN_TYPE = "text/markdown; charset=utf-8"
const MARKDOWN_RANGES = ["text/markdown", "text/x-markdown"]

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request)
    const url = new URL(request.url)
    if (!isPage(url.pathname)) return env.ASSETS.fetch(request)
    if (!prefersMarkdown(request.headers.get("Accept"))) {
      return varyOnAccept(await env.ASSETS.fetch(request))
    }

    // Asked first as HTML would be, so a spelling the asset server redirects is redirected here too
    // instead of answered with a twin whose relative links would resolve against the wrong path.
    const page = await env.ASSETS.fetch(new Request(url, { method: "HEAD", redirect: "manual" }))
    await page.body?.cancel()
    if (page.status === 404) return notFound(request, url)
    if (!page.ok) return varyOnAccept(await env.ASSETS.fetch(request))

    const twinUrl = new URL(url)
    twinUrl.pathname = markdownTwin(url.pathname)
    twinUrl.search = ""
    const twin = await env.ASSETS.fetch(new Request(twinUrl, request))
    if (twin.status === 404) {
      await twin.body?.cancel()
      return varyOnAccept(await env.ASSETS.fetch(request))
    }
    if (!twin.ok && twin.status !== 304) return varyOnAccept(twin)
    const headers = new Headers(twin.headers)
    headers.set("Content-Type", MARKDOWN_TYPE)
    return varyOnAccept(new Response(twin.body, { status: twin.status, headers }))
  },
}

// A path with any extension other than `.html` names a file, not a page, so it is never negotiated.
function isPage(pathname: string): boolean {
  const name = pathname.slice(pathname.lastIndexOf("/") + 1)
  return !name.includes(".") || name.endsWith(".html")
}

// The build writes each page's Markdown copy beside it, a section index `/a/` as `/a.md`.
function markdownTwin(pathname: string): string {
  if (pathname === "/") return "/llms.txt"
  return `${pathname.replace(/\/$/, "")}.md`
}

// Markdown is chosen only when it is named outright and ranked no lower than HTML, so browsers and
// `*/*` clients keep the HTML page.
function prefersMarkdown(accept: string | null): boolean {
  if (accept === null) return false
  const ranges = accept.split(",").flatMap((entry) => {
    const [range, ...params] = entry.split(";").map((part) => part.trim().toLowerCase())
    if (!range) return []
    const q = params
      .map((param) => param.split("=").map((part) => part.trim()))
      .find(([name]) => name === "q")?.[1]
    return [{ range, q: q === undefined ? 1 : Number(q) || 0 }]
  })
  const quality = (type: string) => {
    const [major] = type.split("/")
    const match =
      ranges.find(({ range }) => range === type) ??
      ranges.find(({ range }) => range === `${major}/*`) ??
      ranges.find(({ range }) => range === "*/*")
    return match?.q ?? 0
  }
  const markdown = Math.max(
    0,
    ...ranges.filter(({ range }) => MARKDOWN_RANGES.includes(range)).map(({ q }) => q),
  )
  return markdown > 0 && markdown >= quality("text/html")
}

function varyOnAccept(response: Response): Response {
  const varied = new Response(response.body, response)
  const vary = varied.headers.get("Vary")
  const named = vary?.split(",").some((field) => field.trim().toLowerCase() === "accept")
  if (!named) varied.headers.set("Vary", vary ? `${vary}, Accept` : "Accept")
  return varied
}

function notFound(request: Request, url: URL): Response {
  const body = `# Page not found

Nothing is published at \`${url.pathname}\` on ${url.origin}.

- [llms.txt](${url.origin}/llms.txt) lists every page of the documentation, each as Markdown.
- [sitemap.xml](${url.origin}/sitemap.xml) lists every page as HTML.
`
  return varyOnAccept(
    new Response(request.method === "HEAD" ? null : body, {
      status: 404,
      headers: { "Content-Type": MARKDOWN_TYPE },
    }),
  )
}

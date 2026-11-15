import { describe, expect, it } from "vitest"
import worker from "../worker/index"

type File = { body: string; type: string; status?: number; headers?: Record<string, string> }

const HTML = "text/html; charset=utf-8"
const MARKDOWN_TYPE = "text/markdown; charset=utf-8"

const html = (body: string, extra: Partial<File> = {}): File => ({ body, type: HTML, ...extra })
const markdown = (body: string, extra: Partial<File> = {}): File => ({
  body,
  type: MARKDOWN_TYPE,
  ...extra,
})

// Laid out as the site's build output is: pages as `.html`, a section index as `dir/index.html`,
// and each page's Markdown copy beside it.
const FILES: Record<string, File> = {
  "/index.html": html("<h1>Home</h1>"),
  "/llms.txt": { body: "# Aburi\n\n> overview", type: "text/plain; charset=utf-8" },
  "/guide/page.html": html("<h1>Page</h1>"),
  "/guide/page.md": markdown("# Page\n\nbody"),
  "/section/index.html": html("<h1>Section</h1>"),
  "/section.md": markdown("# Section"),
  "/html-only.html": html("<h1>No Markdown twin</h1>"),
  "/flaky.html": html("<h1>Flaky</h1>"),
  "/flaky.md": markdown("", { status: 503 }),
  "/varied.html": html("<h1>Varied</h1>", { headers: { Vary: "Accept-Encoding" } }),
  "/lower-varied.html": html("<h1>Lower</h1>", { headers: { Vary: "accept" } }),
  "/brand/og.png": { body: "png", type: "image/png" },
  "//doubled/page.html": html("<h1>Doubled</h1>"),
  "//doubled/page.md": markdown("# Doubled"),
}

const NOT_FOUND_PAGE = "<h1>404 page</h1>"

type Resolved = { file: string } | { redirect: string } | undefined

// Mirrors the asset server's auto-trailing-slash handling: a page is served at its clean URL, and the
// other spellings of it redirect there.
function resolve(pathname: string): Resolved {
  if (pathname.endsWith(".html")) {
    if (FILES[pathname] === undefined) return undefined
    return { redirect: pathname.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "") }
  }
  if (pathname.endsWith("/")) {
    if (FILES[`${pathname}index.html`]) return { file: `${pathname}index.html` }
    const page = pathname.slice(0, -1)
    if (page !== "" && FILES[`${page}.html`]) return { redirect: page }
    return undefined
  }
  if (FILES[pathname]) return { file: pathname }
  if (FILES[`${pathname}.html`]) return { file: `${pathname}.html` }
  if (FILES[`${pathname}/index.html`]) return { redirect: `${pathname}/` }
  return undefined
}

function assets() {
  const requests: Request[] = []
  return {
    requests,
    fetch(request: Request): Promise<Response> {
      requests.push(request)
      return Promise.resolve(answer(request))
    },
  }
}

function answer(request: Request): Response {
  const resolved = resolve(new URL(request.url).pathname)
  const withBody = (body: string) => (request.method === "HEAD" ? null : body)
  if (resolved === undefined) {
    return new Response(withBody(NOT_FOUND_PAGE), {
      status: 404,
      headers: { "Content-Type": HTML },
    })
  }
  if ("redirect" in resolved) {
    // As a fetch does, the binding follows a redirect itself unless the request says otherwise.
    if (request.redirect === "follow") {
      return answer(new Request(new URL(resolved.redirect, request.url), request))
    }
    return new Response(null, { status: 307, headers: { Location: resolved.redirect } })
  }
  const file = FILES[resolved.file] as File
  const etag = `"${resolved.file}"`
  const headers = { "Content-Type": file.type, ETag: etag, ...file.headers }
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(withBody(file.body), { status: file.status ?? 200, headers })
}

interface Ask {
  accept?: string
  method?: string
  headers?: Record<string, string>
  origin?: string
}

function get(path: string, { accept, method = "GET", headers = {}, origin }: Ask = {}) {
  const site = assets()
  // A request a Worker receives does not follow redirects.
  const request = new Request(`${origin ?? "https://aburi.dev"}${path}`, {
    method,
    headers: accept === undefined ? headers : { ...headers, Accept: accept },
    redirect: "manual",
  })
  return { response: worker.fetch(request, { ASSETS: site }), site }
}

const MARKDOWN = "text/markdown"

describe("a request that asks for Markdown", () => {
  it.each([
    ["/", "# Aburi\n\n> overview"],
    ["/guide/page", "# Page\n\nbody"],
    ["/guide/page?tab=1", "# Page\n\nbody"],
    ["/section/", "# Section"],
  ])("for the page %s is answered with its Markdown twin", async (path, body) => {
    const response = await get(path, { accept: MARKDOWN }).response
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe(MARKDOWN_TYPE)
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe(body)
  })

  it.each([
    ["/guide/page/", "/guide/page"],
    ["/guide/page.html", "/guide/page"],
    ["/index.html", "/"],
    ["/section", "/section/"],
  ])("for %s is redirected to the page's own URL %s, as HTML is", async (path, location) => {
    const response = await get(path, { accept: MARKDOWN }).response
    expect(response.status).toBe(307)
    expect(response.headers.get("Location")).toBe(location)
    expect(response.headers.get("Vary")).toBe("Accept")
  })

  it("for a page with no Markdown twin falls back to the HTML page", async () => {
    const response = await get("/html-only", { accept: MARKDOWN }).response
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe(HTML)
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe("<h1>No Markdown twin</h1>")
  })

  it("for a page whose twin fails is answered with that failure, not with the HTML page", async () => {
    const response = await get("/flaky", { accept: MARKDOWN }).response
    expect(response.status).toBe(503)
    expect(response.headers.get("Vary")).toBe("Accept")
  })

  it("for a path that does not exist is a 404 in Markdown pointing at the site's indexes", async () => {
    const response = await get("/no/such/page", {
      accept: MARKDOWN,
      origin: "https://preview.example.dev",
    }).response
    expect(response.status).toBe(404)
    expect(response.headers.get("Content-Type")).toBe(MARKDOWN_TYPE)
    expect(response.headers.get("Vary")).toBe("Accept")
    const body = await response.text()
    expect(body).toContain("/no/such/page")
    expect(body).toContain("https://preview.example.dev/llms.txt")
    expect(body).toContain("https://preview.example.dev/sitemap.xml")
  })

  it("for a path starting with // asks for its twin on the site's own host", async () => {
    const { response, site } = get("//doubled/page", { accept: MARKDOWN })
    expect(await (await response).text()).toBe("# Doubled")
    expect(site.requests.map(({ url }) => new URL(url).host)).toEqual(
      site.requests.map(() => "aburi.dev"),
    )
  })

  it("asks for the twin without the page's query", async () => {
    const { response, site } = get("/guide/page?tab=1", { accept: MARKDOWN })
    await response
    const twin = site.requests.find(({ url }) => new URL(url).pathname === "/guide/page.md")
    expect(twin && new URL(twin.url).search).toBe("")
  })

  it("by HEAD carries the Markdown headers and no body", async () => {
    const response = await get("/guide/page", { accept: MARKDOWN, method: "HEAD" }).response
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe(MARKDOWN_TYPE)
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe("")
  })

  it("by HEAD for a path that does not exist is a 404 with no body", async () => {
    const response = await get("/no/such/page", { accept: MARKDOWN, method: "HEAD" }).response
    expect(response.status).toBe(404)
    expect(response.headers.get("Content-Type")).toBe(MARKDOWN_TYPE)
    expect(await response.text()).toBe("")
  })

  it("revalidating its cached copy is answered 304 with the Markdown headers", async () => {
    const response = await get("/guide/page", {
      accept: MARKDOWN,
      headers: { "If-None-Match": '"/guide/page.md"' },
    }).response
    expect(response.status).toBe(304)
    expect(response.headers.get("Content-Type")).toBe(MARKDOWN_TYPE)
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe("")
  })

  it.each([
    ["/brand/og.png", "image/png"],
    ["/guide/page.md", MARKDOWN_TYPE],
  ])("for the file %s is answered with that file", async (path, type) => {
    const response = await get(path, { accept: MARKDOWN }).response
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe(type)
  })
})

describe("the Accept header", () => {
  it.each([
    "text/markdown",
    "text/x-markdown",
    "text/markdown, text/html",
    "text/html, text/markdown",
    "text/html;q=0.5, text/markdown",
    "text/plain, text/markdown;q=0.9, */*;q=0.1",
    "TEXT/Markdown ; q=1",
  ])("%j selects Markdown", async (accept) => {
    const response = await get("/guide/page", { accept }).response
    expect(response.headers.get("Content-Type")).toBe(MARKDOWN_TYPE)
  })

  it.each([
    [undefined],
    ["*/*"],
    ["text/*"],
    ["text/html"],
    ["text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8"],
    ["text/markdown;q=0"],
    ["text/markdown; q = 0"],
    ["text/markdown;charset=utf-8;q=0"],
    ["text/html, text/markdown;q=0.9"],
    ["text/markdown;q=0.5, */*"],
    ["text/*, text/markdown;q=0.5"],
  ])("%j keeps the HTML page", async (accept) => {
    const response = await get("/guide/page", accept === undefined ? {} : { accept }).response
    expect(response.headers.get("Content-Type")).toBe(HTML)
    expect(await response.text()).toBe("<h1>Page</h1>")
  })
})

describe("a request for HTML", () => {
  it("is answered with the page and a Vary on Accept", async () => {
    const response = await get("/guide/page", { accept: "text/html" }).response
    expect(response.status).toBe(200)
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe("<h1>Page</h1>")
  })

  it("for a path that does not exist keeps the site's 404 page", async () => {
    const response = await get("/no/such/page", { accept: "text/html" }).response
    expect(response.status).toBe(404)
    expect(response.headers.get("Content-Type")).toBe(HTML)
    expect(response.headers.get("Vary")).toBe("Accept")
    expect(await response.text()).toBe(NOT_FOUND_PAGE)
  })

  it.each([
    ["/varied", "Accept-Encoding, Accept"],
    ["/lower-varied", "accept"],
  ])("for %s keeps the Vary the page already carries", async (path, vary) => {
    const response = await get(path, { accept: "text/html" }).response
    expect(response.headers.get("Vary")).toBe(vary)
  })

  it("never asks for a Markdown twin", async () => {
    const { response, site } = get("/guide/page", { accept: "text/html" })
    await response
    expect(site.requests.map(({ url }) => new URL(url).pathname)).toEqual(["/guide/page"])
  })
})

describe("a request that is neither GET nor HEAD", () => {
  it("is passed to the assets as it came", async () => {
    const { response, site } = get("/guide/page", { accept: MARKDOWN, method: "POST" })
    const answered = await response
    expect(answered.headers.get("Content-Type")).toBe(HTML)
    expect(answered.headers.get("Vary")).toBeNull()
    expect(site.requests.map(({ method }) => method)).toEqual(["POST"])
    expect(site.requests[0]?.headers.get("Accept")).toBe(MARKDOWN)
  })
})

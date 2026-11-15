import { readShowcase, readShowcasePage, showcaseIndexPage } from "./showcase.ts"

export default {
  paths() {
    return [
      { params: { slug: "index" }, content: showcaseIndexPage() },
      ...readShowcase().map(({ slug }) => ({
        params: { slug },
        content: readShowcasePage(slug),
      })),
    ]
  },
}

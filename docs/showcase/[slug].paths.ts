import { readShowcase, readShowcasePage, showcaseIndexPage } from "./showcase.ts"

export default {
  paths(): { params: { slug: string }; content: string }[] {
    return [
      { params: { slug: "index" }, content: showcaseIndexPage() },
      ...readShowcase().map(({ slug }) => ({
        params: { slug },
        content: readShowcasePage(slug),
      })),
    ]
  },
}

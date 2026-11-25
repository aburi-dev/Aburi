import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { trpcEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("trpc-local-client")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [trpcEffectsPlugin] })

const CLIENT = [
  'import { createTRPCReact } from "@trpc/react-query"',
  'import type { AppRouter } from "../server/router"',
  "",
  "export const api = createTRPCReact<AppRouter>()",
  "export const formatDate = (date: Date) => date.toISOString()",
]

describe("scan — a tRPC client the workspace wraps in a module of its own", () => {
  it("classifies a call on the client the file imports from the wrapper", async () => {
    await workspace.writeSources({
      "src/utils/trpc.ts": CLIENT,
      "src/posts.ts": [
        'import { api } from "./utils/trpc"',
        "",
        "export function usePosts() {",
        "  return api.post.list.useQuery()",
        "}",
      ],
    })
    const usePosts = symbolById(await scanWorkspace(), "ts:src/posts.ts#usePosts")
    expect(usePosts.effects.map((effect) => [effect.id, effect.target, effect.confidence])).toEqual(
      [["network.rpc", "api.post.list.useQuery", "high"]],
    )
  })

  it("leaves a call on another name alone though the file imports from the wrapper", async () => {
    await workspace.writeSources({
      "src/utils/trpc.ts": CLIENT,
      "src/feed.ts": [
        'import { formatDate } from "./utils/trpc"',
        "",
        "export function useFeed(store: { feed: { latest: { useQuery(): unknown } } }) {",
        "  formatDate(new Date())",
        "  return store.feed.latest.useQuery()",
        "}",
      ],
    })
    const useFeed = symbolById(await scanWorkspace(), "ts:src/feed.ts#useFeed")
    expect(useFeed.effects).toEqual([])
  })
})

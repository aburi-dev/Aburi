import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { frameworkEntries, symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { trpcFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("trpc-scan")

const SERVER_IMPORT = `import { initTRPC } from "@trpc/server"`

async function scanWorkspace(): Promise<IR> {
  const { ir } = await scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [trpcFrameworkPlugin],
  })
  return ir
}

/** `"<extKind> <confidence> <derivedBy tags>"` for a classified Symbol, `null` for any other. */
function classification(s: IRSymbol): string | null {
  if (s.extKind === null) return null
  return [s.extKind, s.confidence, ...frameworkEntries(s, "framework:trpc:")].join(" ")
}

/** `"<name> <classification>"` per classified Symbol in `path`, sorted. */
function classifiedIn(ir: IR, path: string): string[] {
  return ir.symbols
    .filter((s) => s.source.file === path && s.extKind !== null)
    .map((s) => `${s.name} ${classification(s)}`)
    .sort()
}

/** The classification of `subject`, declared as `export const subject = <initializer>` under `header`. */
async function subjectIn(initializer: string, header = SERVER_IMPORT): Promise<string | null> {
  await workspace.writeSource(
    "src/server.ts",
    [header, `export const subject = ${initializer}`].join("\n"),
  )
  return classification(symbolNamed({ ir: await scanWorkspace() }, "subject"))
}

describe("scan — a tRPC server laid out as create-t3-app writes it", () => {
  it("classifies the instance, base procedures, middleware, procedures and routers in every file", async () => {
    await workspace.writeSource(
      "src/server/api/trpc.ts",
      [
        `import { initTRPC, TRPCError } from "@trpc/server"`,
        `const t = initTRPC.context<Context>().create({ transformer: superjson })`,
        `export const createCallerFactory = t.createCallerFactory`,
        `export const createTRPCRouter = t.router`,
        `const timingMiddleware = t.middleware(async ({ next }) => next())`,
        `export const publicProcedure = t.procedure.use(timingMiddleware)`,
        `export const protectedProcedure = t.procedure`,
        `  .use(timingMiddleware)`,
        `  .use(({ ctx, next }) => {`,
        `    if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" })`,
        `    return next({ ctx })`,
        `  })`,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/server/api/routers/post.ts",
      [
        `import { z } from "zod"`,
        `import { createTRPCRouter, publicProcedure } from "~/server/api/trpc"`,
        `export const latest = publicProcedure.query(({ ctx }) => ctx.db.post.findFirst())`,
        `export const postRouter = createTRPCRouter({ latest })`,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/server/api/root.ts",
      [
        `import { postRouter } from "~/server/api/routers/post"`,
        `import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc"`,
        `export const appRouter = createTRPCRouter({ post: postRouter })`,
        `export const createCaller = createCallerFactory(appRouter)`,
      ].join("\n"),
    )

    const ir = await scanWorkspace()

    expect(classifiedIn(ir, "src/server/api/trpc.ts")).toEqual([
      "protectedProcedure framework:trpc:base-procedure high framework:trpc:base-procedure:t.use",
      "publicProcedure framework:trpc:base-procedure high framework:trpc:base-procedure:t.use",
      "t framework:trpc:instance high framework:trpc:instance:initTRPC.create",
      "timingMiddleware framework:trpc:middleware high framework:trpc:middleware:t.middleware",
    ])
    expect(classifiedIn(ir, "src/server/api/routers/post.ts")).toEqual([
      "latest framework:trpc:procedure medium framework:trpc:procedure:publicProcedure.query",
      "postRouter framework:trpc:router medium framework:trpc:router:createTRPCRouter",
    ])
    expect(classifiedIn(ir, "src/server/api/root.ts")).toEqual([
      "appRouter framework:trpc:router medium framework:trpc:router:createTRPCRouter",
    ])
  })

  it("walks a procedure's chain and its resolver, so their calls are the procedure's", async () => {
    await workspace.writeSource(
      "src/server.ts",
      [
        SERVER_IMPORT,
        `export const byId = publicProcedure`,
        `  .input(z.object({ id: z.string() }))`,
        `  .query(({ ctx, input }) => ctx.db.user.findUnique({ where: { id: input.id } }))`,
      ].join("\n"),
    )

    const byId = symbolNamed({ ir: await scanWorkspace() }, "byId")

    expect(byId.extKind).toBe("framework:trpc:procedure")
    expect(byId.calls.map((call) => call.target)).toEqual([
      "publicProcedure.input.query",
      "publicProcedure.input",
      "publicProcedure",
      "z.object",
      "z.string",
      "ctx.db.user.findUnique",
    ])
  })
})

describe("scan — a procedure written inside a router", () => {
  it("is walked as part of the router, which carries its resolver's calls and rules", async () => {
    await workspace.writeSource(
      "src/server.ts",
      [
        SERVER_IMPORT,
        "export const postRouter = t.router({",
        "  byId: publicProcedure.input(z.string()).query(({ ctx, input }) => {",
        '    if (!input) throw new TRPCError({ code: "BAD_REQUEST" })',
        "    return ctx.db.post.findUnique({ where: { id: input } })",
        "  }),",
        "})",
      ].join("\n"),
    )

    const ir = await scanWorkspace()
    const postRouter = symbolNamed({ ir }, "postRouter")

    expect(classifiedIn(ir, "src/server.ts")).toEqual([
      "postRouter framework:trpc:router high framework:trpc:router:t.router",
    ])
    expect(postRouter.rules.map((rule) => rule.type)).toEqual(["guard", "throw"])
    expect(postRouter.calls.map((call) => call.target)).toEqual([
      "t.router",
      "publicProcedure.input.query",
      "publicProcedure.input",
      "z.string",
      "publicProcedure",
      "TRPCError",
      "ctx.db.post.findUnique",
    ])
  })

  /** The router's `middleware`, for `export const appRouter = t.router(<procedures>)`. */
  async function routerMiddleware(procedures: string[]): Promise<readonly string[] | undefined> {
    await workspace.writeSource(
      "src/server.ts",
      [SERVER_IMPORT, "export const appRouter = t.router({", ...procedures, "})"].join("\n"),
    )
    return symbolNamed({ ir: await scanWorkspace() }, "appRouter").middleware
  }

  it.each([
    [
      "each procedure's base procedure, under its key",
      ["  list: publicProcedure.query(() => []),", "  delete: protectedProcedure.mutation(fn),"],
      ["list:publicProcedure", "delete:protectedProcedure"],
    ],
    [
      "what a procedure's chain uses, after its base",
      ["  delete: protectedProcedure.use(isAdmin).input(z.string()).mutation(fn),"],
      ["delete:protectedProcedure", "delete:isAdmin"],
    ],
    [
      "a nested router's procedures, under the path of keys",
      ["  post: t.router({", "    delete: protectedProcedure.mutation(fn),", "  }),"],
      ["post.delete:protectedProcedure"],
    ],
    [
      "a quoted key as its value, and a computed one as computed",
      ['  "by-id": publicProcedure.query(fn),', "  [name]: protectedProcedure.query(fn),"],
      ["by-id:publicProcedure", "<computed>:protectedProcedure"],
    ],
  ])("names %s", async (_label, procedures, middleware) => {
    expect(await routerMiddleware(procedures)).toEqual(middleware)
  })

  it.each([
    ["a procedure on the instance's own procedure", ["  list: t.procedure.query(() => []),"]],
    ["a procedure the router names by reference", ["  list,", "  byId: byIdProcedure,"]],
    ["a nested router named by reference", ["  post: postRouter,"]],
  ])("names nothing for %s", async (_label, procedures) => {
    expect(await routerMiddleware(procedures)).toBeUndefined()
  })

  it("calls the base procedure an inline procedure is built on", async () => {
    await workspace.writeSource(
      "src/trpc.ts",
      [
        SERVER_IMPORT,
        "const t = initTRPC.create()",
        "export const protectedProcedure = t.procedure.use(isAuthed)",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/server.ts",
      [
        SERVER_IMPORT,
        'import { protectedProcedure } from "./trpc"',
        "export const appRouter = t.router({",
        "  delete: protectedProcedure.mutation(fn),",
        "})",
      ].join("\n"),
    )

    const appRouter = symbolNamed({ ir: await scanWorkspace() }, "appRouter")

    expect(appRouter.calls.find((call) => call.target === "protectedProcedure")?.resolved).toBe(
      "ts:src/trpc.ts#protectedProcedure",
    )
  })
})

describe("scan — what a const's initializer makes it", () => {
  it.each([
    ["the instance initTRPC creates", "initTRPC.create()", "instance:initTRPC.create"],
    [
      "an instance configured on the way",
      "initTRPC.context<Context>().meta<Meta>().create({ transformer })",
      "instance:initTRPC.create",
    ],
    ["a router the instance builds", "t.router({ user: userRouter })", "router:t.router"],
    [
      "a router built through an alias of the instance's factory",
      `router({ greeting: publicProcedure.query(() => "hi") })`,
      "router:router",
    ],
    ["create-t3-app's router factory", "createTRPCRouter({})", "router:createTRPCRouter"],
    ["routers merged on the instance", "t.mergeRouters(a, b)", "router:t.mergeRouters"],
    ["routers merged by the standalone helper", "mergeRouters(a, b)", "router:mergeRouters"],
    ["a router behind satisfies", "t.router({}) satisfies AnyRouter", "router:t.router"],
    [
      "a query",
      "publicProcedure.input(z.string()).query(({ input }) => find(input))",
      "procedure:publicProcedure.query",
    ],
    [
      "a mutation",
      "protectedProcedure.mutation(async ({ input }) => save(input))",
      "procedure:protectedProcedure.mutation",
    ],
    [
      "a subscription built straight off the instance",
      "t.procedure.subscription(() => observable(emit))",
      "procedure:t.subscription",
    ],
    [
      "a subscription written as an async generator",
      "publicProcedure.subscription(async function* (opts) { yield 1 })",
      "procedure:publicProcedure.subscription",
    ],
    [
      "a resolver declared elsewhere",
      "publicProcedure.query(listUsers)",
      "procedure:publicProcedure.query",
    ],
    [
      "a resolver read off a module",
      "publicProcedure.query(handlers.listUsers)",
      "procedure:publicProcedure.query",
    ],
    [
      "a resolver written as a function expression",
      "publicProcedure.query(function listUsers() { return [] })",
      "procedure:publicProcedure.query",
    ],
    [
      "a resolver wrapped in a call",
      "publicProcedure.query(withCache(listUsers))",
      "procedure:publicProcedure.query",
    ],
    [
      "a resolver behind a comment in the argument list",
      "publicProcedure.query(/* by id */ ({ input }) => find(input))",
      "procedure:publicProcedure.query",
    ],
    [
      "a chain from a base procedure named procedure",
      "procedure.query(listUsers)",
      "procedure:procedure.query",
    ],
    [
      "a builder behind a type assertion",
      "(publicProcedure as typeof base).query(() => 1)",
      "procedure:publicProcedure.query",
    ],
    [
      "a chain wrapped over lines with a comment in it",
      "publicProcedure\n  .input(schema)\n  // by id\n  .query(({ input }) => find(input))",
      "procedure:publicProcedure.query",
    ],
    ["the instance's procedure", "t.procedure", "base-procedure:t.procedure"],
    ["a procedure with middleware", "t.procedure.use(isAuthed)", "base-procedure:t.use"],
    [
      "a base procedure extending another",
      "protectedProcedure.use(isAdmin)",
      "base-procedure:protectedProcedure.use",
    ],
    [
      "a base procedure fixing an input",
      "publicProcedure.input(z.object({ id: z.string() }))",
      "base-procedure:publicProcedure.input",
    ],
    [
      "a base procedure fixing an output",
      "publicProcedure.output(z.string())",
      "base-procedure:publicProcedure.output",
    ],
    [
      "a base procedure carrying meta",
      "publicProcedure.meta({ openapi: { method: 'GET' } })",
      "base-procedure:publicProcedure.meta",
    ],
    [
      "a base procedure joining another's middleware",
      "publicProcedure.concat(authedProcedure)",
      "base-procedure:publicProcedure.concat",
    ],
    [
      "a middleware the instance builds",
      "t.middleware(async ({ next }) => next())",
      "middleware:t.middleware",
    ],
    ["a middleware built through an alias", "middleware(enforceAuth)", "middleware:middleware"],
  ])("%s is classified", async (_shape, initializer, entry) => {
    const role = entry.slice(0, entry.indexOf(":"))
    expect(await subjectIn(initializer)).toBe(`framework:trpc:${role} high framework:trpc:${entry}`)
  })

  it.each([
    ["a query on something that is not a procedure", "db.query(() => rows())"],
    ["a client call", "client.user.byId.query({ id: 1 })"],
    ["a procedure terminal handed no resolver", "publicProcedure.query()"],
    ["a step tRPC's builder does not have", "publicProcedure.pipe(transform)"],
    ["another library's router factory", "createRouter({ routes })"],
    ["a router factory handed no procedures", `router("/api")`],
    ["a router factory handed nothing", "router()"],
    ["a router factory handed more than its procedures", "router({}, extra)"],
    ["routers merged from none", "t.mergeRouters()"],
    ["a procedure read off something the instance holds", "a.b.procedure"],
    ["a procedure read off this", "this.procedure"],
    ["a procedure that is not read off the instance", "appointment.details.procedure.query(list)"],
    ["a query run as a tagged template", "storedProcedure.query`select 1`"],
    ["another library's create", "Store.create()"],
    ["an alias of the instance's router factory", "t.router"],
    ["an alias of the instance's middleware factory", "t.middleware"],
    ["a middleware factory handed no function", "t.middleware({ name: 'timing' })"],
  ])("%s is not classified", async (_shape, initializer) => {
    expect(await subjectIn(initializer)).toBeNull()
  })

  it.each([
    ["the instance's procedure", "t.procedure"],
    ["a procedure field of a domain object", "form.procedure"],
  ])(
    "%s is not classified in a file that does not import @trpc/server",
    async (_shape, initializer) => {
      expect(await subjectIn(initializer, "")).toBeNull()
    },
  )

  // Only the receiver's name tells these from tRPC's, and the file's imports keep them at medium.
  it.each([
    [
      "a ts-rest contract",
      `c.router({ getPost: { method: "GET", path: "/posts/:id" } })`,
      "router:c.router",
    ],
    ["a server's middleware hook", "app.middleware(handler)", "middleware:app.middleware"],
    [
      "a query on a name ending in Procedure",
      "storedProcedure.query(sql)",
      "procedure:storedProcedure.query",
    ],
  ])("%s is read as tRPC's at medium confidence", async (_shape, initializer, entry) => {
    const role = entry.slice(0, entry.indexOf(":"))
    expect(await subjectIn(initializer, "")).toBe(
      `framework:trpc:${role} medium framework:trpc:${entry}`,
    )
  })

  it("classifies a router a default export builds", async () => {
    await workspace.writeSource(
      "src/server.ts",
      [
        SERVER_IMPORT,
        "const t = initTRPC.create()",
        "export default t.router({ user: userRouter })",
      ].join("\n"),
    )

    expect(classifiedIn(await scanWorkspace(), "src/server.ts")).toEqual([
      "<default> framework:trpc:router high framework:trpc:router:t.router",
      "t framework:trpc:instance high framework:trpc:instance:initTRPC.create",
    ])
  })

  it("reads only the const's own declarator", async () => {
    await workspace.writeSource(
      "src/server.ts",
      [SERVER_IMPORT, `export const version = 1, appRouter = t.router({})`].join("\n"),
    )

    expect(classifiedIn(await scanWorkspace(), "src/server.ts")).toEqual([
      "appRouter framework:trpc:router high framework:trpc:router:t.router",
    ])
  })
})

describe("scan — the middleware a procedure runs", () => {
  async function middlewareOf(initializer: string): Promise<readonly string[] | undefined> {
    await workspace.writeSource(
      "src/server.ts",
      [SERVER_IMPORT, `export const subject = ${initializer}`].join("\n"),
    )
    return symbolNamed({ ir: await scanWorkspace() }, "subject").middleware
  }

  it.each([
    ["what a procedure's own use is handed", "t.procedure.use(isAuthed).query(list)", ["isAuthed"]],
    [
      "every use on its chain, in the order they run",
      "t.procedure.use(timing).input(schema).use(isAuthed).mutation(save)",
      ["timing", "isAuthed"],
    ],
    [
      "each as framework-express names its middleware",
      `t.procedure.use(requireRole('admin')).query(list)`,
      [`requireRole("admin")`],
    ],
    [
      "a step in the middle of the chain behind a type assertion",
      "(t.procedure.use(isAuthed) as Base).use(audit).query(list)",
      ["isAuthed", "audit"],
    ],
    [
      "a middleware made by the instance, but not its body",
      "t.procedure.use(t.middleware(async ({ next }) => next())).query(list)",
      ["t.middleware(…)"],
    ],
    ["the base procedure it is built on", "protectedProcedure.query(list)", ["protectedProcedure"]],
    [
      "the builder concat joins, where it joins it",
      "publicProcedure.use(timing).concat(authedProcedure).query(list)",
      ["publicProcedure", "timing", "authedProcedure"],
    ],
    ["what a base procedure adds", "t.procedure.use(isAuthed)", ["isAuthed"]],
    [
      "the base procedure a base procedure extends, then what it adds",
      "protectedProcedure.use(isAdmin)",
      ["protectedProcedure", "isAdmin"],
    ],
  ])("records %s", async (_label, initializer, middleware) => {
    expect(await middlewareOf(initializer)).toEqual(middleware)
  })

  it.each([
    ["a procedure built on the instance's procedure alone", "t.procedure.query(list)"],
    [
      "a procedure whose middleware is an inline function",
      "t.procedure.use(({ ctx, next }) => next({ ctx })).query(list)",
    ],
    [
      "an inline middleware behind a type assertion",
      "t.procedure.use((({ next }) => next()) as Middleware).query(list)",
    ],
    ["the instance's procedure", "t.procedure"],
    ["a middleware", "t.middleware(async ({ next }) => next())"],
  ])("leaves the field out for %s", async (_label, initializer) => {
    expect(await middlewareOf(initializer)).toBeUndefined()
  })

  it("names middleware the same however the chain is wrapped and commented", async () => {
    const wrapped = await middlewareOf(
      [
        "t.procedure",
        "  // the gate",
        "  .use(",
        "    requireRole( /* the role */ 'admin' ),",
        "  )",
        "  .use(auth",
        "    .required)",
        "  .query(list)",
      ].join("\n"),
    )

    expect(wrapped).toEqual([`requireRole("admin")`, "auth.required"])
  })
})

describe("scan — the calls a procedure makes through what it is built on", () => {
  const HEADER = [
    SERVER_IMPORT,
    `import * as auth from "./auth"`,
    `import { authedProcedure, createProcedure, isAdmin, protectedProcedure, requireRole } from "./trpc"`,
  ]

  async function subjectOf(initializer: string): Promise<IRSymbol> {
    await workspace.writeSource(
      "src/trpc.ts",
      [
        SERVER_IMPORT,
        "const t = initTRPC.create()",
        "export const protectedProcedure = t.procedure.use(({ next }) => next())",
        "export const authedProcedure = t.procedure.use(({ next }) => next())",
        "export const isAdmin = t.middleware(({ next }) => next())",
        "export function requireRole(role: string) { return isAdmin }",
        "export function createProcedure(permission: string) { return protectedProcedure }",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/auth.ts",
      [
        SERVER_IMPORT,
        "export const required = initTRPC.create().middleware(({ next }) => next())",
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/server.ts",
      [...HEADER, `export const subject = ${initializer}`].join("\n"),
    )
    return symbolNamed({ ir: await scanWorkspace() }, "subject")
  }

  /** `"<target> L<line> → <id>"` per call of `subject` that resolves, in `calls[]` order. */
  async function resolvedCallsOf(initializer: string): Promise<string[]> {
    return (await subjectOf(initializer)).calls.flatMap((call) =>
      call.resolved === null ? [] : [`${call.target} L${call.line} → ${call.resolved}`],
    )
  }

  it.each([
    [
      "the base procedure a procedure is built on",
      "protectedProcedure.query(list)",
      ["protectedProcedure L4 → ts:src/trpc.ts#protectedProcedure"],
    ],
    [
      "the base procedure a base procedure extends, then the middleware it adds",
      "protectedProcedure.use(isAdmin)",
      [
        "protectedProcedure L4 → ts:src/trpc.ts#protectedProcedure",
        "isAdmin L4 → ts:src/trpc.ts#isAdmin",
      ],
    ],
    [
      "a member path, written with a dot or a string key",
      `t.procedure.use(auth.required).use(auth["required"]).query(list)`,
      ["auth.required L4 → ts:src/auth.ts#required", "auth.required L4 → ts:src/auth.ts#required"],
    ],
    [
      "a middleware factory once, as the call the body makes",
      `t.procedure.use(requireRole("admin")).query(list)`,
      ["requireRole L4 → ts:src/trpc.ts#requireRole"],
    ],
    [
      "a base procedure factory once, as the call the body makes",
      `createProcedure("read").query(list)`,
      ["createProcedure L4 → ts:src/trpc.ts#createProcedure"],
    ],
    [
      "the base procedure and the builder a concat joins",
      "protectedProcedure.concat(authedProcedure).query(list)",
      [
        "protectedProcedure L4 → ts:src/trpc.ts#protectedProcedure",
        "authedProcedure L4 → ts:src/trpc.ts#authedProcedure",
      ],
    ],
  ])("records %s", async (_label, initializer, calls) => {
    expect(await resolvedCallsOf(initializer)).toEqual(calls)
  })

  it("records only the body's calls for the instance's procedure, an inline middleware, a spread or a computed member", async () => {
    const subject = await subjectOf(
      "t.procedure.use(({ next }) => next()).use(...isAdmin).use(auth[isAdmin]).query(list)",
    )

    expect(subject.calls.map((call) => call.target)).toEqual([
      "t.procedure.use.use.use.query",
      "t.procedure.use.use.use",
      "t.procedure.use.use",
      "t.procedure.use",
      "next",
    ])
  })

  it("records each at the line it is written on, among the body's calls by line", async () => {
    const calls = await resolvedCallsOf(
      ["protectedProcedure", "  .use(isAdmin)", '  .mutation(() => requireRole("admin"))'].join(
        "\n",
      ),
    )

    expect(calls).toEqual([
      "protectedProcedure L4 → ts:src/trpc.ts#protectedProcedure",
      "isAdmin L5 → ts:src/trpc.ts#isAdmin",
      "requireRole L6 → ts:src/trpc.ts#requireRole",
    ])
  })
})

describe("scan — the confidence a file's imports give", () => {
  it.each([
    ["@trpc/server", `import { initTRPC } from "@trpc/server"`, "high"],
    ["a type-only import of it", `import type { AnyRouter } from "@trpc/server"`, "high"],
    ["a CommonJS require of it", `const { initTRPC } = require("@trpc/server")`, "high"],
    [
      "one of its subpaths",
      `import { fetchRequestHandler } from "@trpc/server/adapters/fetch"`,
      "high",
    ],
    ["only the client package", `import { createTRPCClient } from "@trpc/client"`, "medium"],
    [
      "a package sharing its name's prefix",
      `import { helper } from "@trpc/server-utils"`,
      "medium",
    ],
    ["nothing", "", "medium"],
  ])("a file importing %s is %s", async (_imports, header, confidence) => {
    await workspace.writeSource(
      "src/server.ts",
      [header, `export const appRouter = createTRPCRouter({})`].join("\n"),
    )

    const appRouter = symbolNamed({ ir: await scanWorkspace() }, "appRouter")

    expect(appRouter.extKind).toBe("framework:trpc:router")
    expect(appRouter.confidence).toBe(confidence)
  })
})

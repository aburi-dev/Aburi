import { CoreError } from "@aburi/core"
import { decorator, errorFrom } from "@aburi/test-support"
import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { classifyDecorated, makeImport, makeNamespaceImport, NEST } from "./fixtures/symbol"

const GRAPHQL = "@nestjs/graphql"
const graphql = (...names: string[]): ImportEdge[] => [makeImport(GRAPHQL, names)]

describe("classifyNestjsSymbol — class decorators", () => {
  it.each([
    ["Module", "module", []],
    ["Controller", "controller", []],
    ["Injectable", "provider", []],
    ["Catch", "filter", []],
    ["WebSocketGateway", "gateway", []],
    ["Resolver", "resolver", graphql("Resolver")],
  ])("makes a class decorated @%s a %s, and flags the decorator", (name, role, imports) => {
    expect(classifyDecorated("class", [name], imports)).toEqual({
      extKind: `framework:nestjs:${role}`,
      decoratorBoundaries: { [name]: true },
      derivedBy: `framework:nestjs:${role}`,
    })
  })

  it.each([
    ["no import binds it", []],
    ["it comes from another GraphQL library", [makeImport("type-graphql", ["Resolver"])]],
    ["it comes from another @nestjs package", [makeImport(NEST, ["Resolver"])]],
  ])("leaves a class decorated @Resolver unclassified when %s", (_label, imports) => {
    expect(classifyDecorated("class", ["Resolver"], imports)).toBeNull()
  })

  it("gives a class the role of its first decorator, and flags every one it recognized", () => {
    expect(classifyDecorated("class", ["Injectable", "Deprecated", "Controller"])).toEqual({
      extKind: "framework:nestjs:provider",
      decoratorBoundaries: { Injectable: true, Controller: true },
      derivedBy: "framework:nestjs:provider",
    })
  })

  it.each([
    ["no decorators", []],
    ["only decorators NestJS does not define", ["SomeOtherThing"]],
    ["only a guard", ["UseGuards"]],
  ])("returns null for a class with %s", (_label, decorators) => {
    expect(classifyDecorated("class", decorators)).toBeNull()
  })
})

describe("classifyNestjsSymbol — guards, interceptors, pipes and filters on a class", () => {
  it.each([
    ["controller", ["UseGuards", "Controller"], []],
    ["controller", ["Controller", "UseInterceptors"], []],
    ["gateway", ["WebSocketGateway", "UsePipes"], []],
    ["resolver", ["Resolver", "UseFilters"], graphql("Resolver")],
  ])("flags them on a %s, as NestJS runs them around its every handler", (role, names, imports) => {
    expect(classifyDecorated("class", names, imports)).toEqual({
      extKind: `framework:nestjs:${role}`,
      decoratorBoundaries: Object.fromEntries(names.map((name) => [name, true])),
      derivedBy: `framework:nestjs:${role}`,
    })
  })

  it("flags them on a class that is a controller as well as its first role", () => {
    expect(classifyDecorated("class", ["Injectable", "UseGuards", "Controller"])).toEqual({
      extKind: "framework:nestjs:provider",
      decoratorBoundaries: { Injectable: true, UseGuards: true, Controller: true },
      derivedBy: "framework:nestjs:provider",
    })
  })

  it.each(["Injectable", "Module", "Catch"])(
    "leaves them unflagged on a class that is only @%s, which has no handlers to run them around",
    (name) => {
      expect(classifyDecorated("class", [name, "UseGuards"])?.decoratorBoundaries).toEqual({
        [name]: true,
      })
    },
  )
})

describe("classifyNestjsSymbol — method decorators", () => {
  it.each([
    "Get",
    "Post",
    "Put",
    "Delete",
    "Patch",
    "Options",
    "Head",
    "Search",
    "All",
    "Sse",
    "MessagePattern",
    "EventPattern",
    "SubscribeMessage",
    "GrpcMethod",
    "GrpcStreamMethod",
    "GrpcStreamCall",
  ])("makes a method decorated @%s a route, and flags the decorator", (name) => {
    expect(classifyDecorated("method", [name])).toEqual({
      extKind: "framework:nestjs:route",
      decoratorBoundaries: { [name]: true },
      derivedBy: `framework:nestjs:route:${name}`,
    })
  })

  it.each(["UseGuards", "UseInterceptors", "UsePipes", "UseFilters"])(
    "flags @%s as a boundary without making the method a route",
    (name) => {
      expect(classifyDecorated("method", [name])).toEqual({
        decoratorBoundaries: { [name]: true },
        derivedBy: `framework:nestjs:handler:${name}`,
      })
    },
  )

  it("makes a guarded method a route by its verb, and flags both decorators", () => {
    expect(classifyDecorated("method", ["UseGuards", "Post"])).toEqual({
      extKind: "framework:nestjs:route",
      decoratorBoundaries: { UseGuards: true, Post: true },
      derivedBy: "framework:nestjs:route:Post",
    })
  })

  it("returns null for a method with no decorator NestJS defines", () => {
    expect(classifyDecorated("method", ["Deprecated"])).toBeNull()
  })
})

describe("classifyNestjsSymbol — GraphQL operations", () => {
  it.each(["Query", "Mutation", "Subscription", "ResolveField", "ResolveReference"])(
    "makes a method decorated @%s from @nestjs/graphql a route",
    (name) => {
      expect(classifyDecorated("method", [name], graphql(name))).toEqual({
        extKind: "framework:nestjs:route",
        decoratorBoundaries: { [name]: true },
        derivedBy: `framework:nestjs:route:${name}`,
      })
    },
  )

  it("makes a method a route through a namespace import of @nestjs/graphql", () => {
    const written = decorator({ name: "Mutation", qualifier: "gql" })

    expect(
      classifyDecorated("method", [written], [makeNamespaceImport(GRAPHQL, "gql")]),
    ).toMatchObject({
      extKind: "framework:nestjs:route",
      decoratorBoundaries: { "gql.Mutation": true },
    })
  })

  it.each([
    ["no import binds it", []],
    ["it is @nestjs/common's parameter decorator", [makeImport(NEST, ["Query"])]],
    ["it comes from another GraphQL library", [makeImport("type-graphql", ["Query"])]],
  ])("leaves a method decorated @Query unclassified when %s", (_label, imports) => {
    expect(classifyDecorated("method", ["Query"], imports)).toBeNull()
  })
})

describe("classifyNestjsSymbol — scheduled and event handlers", () => {
  it.each([
    ["Cron", "@nestjs/schedule"],
    ["Interval", "@nestjs/schedule"],
    ["Timeout", "@nestjs/schedule"],
    ["OnEvent", "@nestjs/event-emitter"],
  ])("flags @%s from %s as a boundary without making the method a route", (name, source) => {
    expect(classifyDecorated("method", [name], [makeImport(source, [name])])).toEqual({
      decoratorBoundaries: { [name]: true },
      derivedBy: `framework:nestjs:trigger:${name}`,
    })
  })

  it.each([
    ["no import binds it", []],
    ["it comes from another package", [makeImport("./timing", ["Timeout"])]],
    ["it comes from the wrong @nestjs package", [makeImport("@nestjs/event-emitter", ["Timeout"])]],
  ])("leaves a method decorated @Timeout unclassified when %s", (_label, imports) => {
    expect(classifyDecorated("method", ["Timeout"], imports)).toBeNull()
  })

  it("names the trigger rather than a guard beside it", () => {
    expect(
      classifyDecorated(
        "method",
        ["UseInterceptors", "Cron"],
        [makeImport("@nestjs/schedule", ["Cron"])],
      ),
    ).toEqual({
      decoratorBoundaries: { UseInterceptors: true, Cron: true },
      derivedBy: "framework:nestjs:trigger:Cron",
    })
  })
})

describe("classifyNestjsSymbol — other Symbol kinds", () => {
  it.each(["function", "interface", "type", "const", "namespace", "enum"] as const)(
    "returns null for a %s, even one decorated @Controller",
    (kind) => {
      expect(classifyDecorated(kind, ["Controller"])).toBeNull()
    },
  )
})

describe("classifyNestjsSymbol — a decorator with an empty name", () => {
  it.each(["class", "method"] as const)("throws a CoreError naming the %s", async (kind) => {
    const error = await errorFrom(CoreError, () => classifyDecorated(kind, [""]))

    expect(error).toMatchObject({
      code: "anonymous-symbol-id-attempted",
      value: kind === "method" ? "ts:src/a.ts#C.m" : "ts:src/a.ts#C",
    })
  })
})

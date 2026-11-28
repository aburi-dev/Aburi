import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { nestjsFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("nestjs-transports")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
  })

describe("scan — NestJS handlers beyond HTTP verbs", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/events.controller.ts",
      [
        `import { Controller, Get, Sse, type MessageEvent } from "@nestjs/common"`,
        `import { interval, map, type Observable } from "rxjs"`,
        ``,
        `@Controller("events")`,
        `export class EventsController {`,
        `  @Get()`,
        `  list() { return [] }`,
        ``,
        `  @Sse("stream")`,
        `  stream(): Observable<MessageEvent> {`,
        `    return interval(1000).pipe(map(() => ({ data: { hello: "world" } })))`,
        `  }`,
        `}`,
        ``,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/users.resolver.ts",
      [
        `import { Args, Mutation, Query, Resolver } from "@nestjs/graphql"`,
        ``,
        `@Resolver("User")`,
        `export class UsersResolver {`,
        `  @Query("users")`,
        `  users() { return [] }`,
        ``,
        `  @Mutation()`,
        `  deleteUser(@Args("id") id: string) { return id }`,
        `}`,
        ``,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/chat.gateway.ts",
      [
        `import { MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets"`,
        ``,
        `@WebSocketGateway()`,
        `export class ChatGateway {`,
        `  @SubscribeMessage("message")`,
        `  handle(@MessageBody() data: string) { return data }`,
        `}`,
        ``,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/heroes.controller.ts",
      [
        `import { Controller } from "@nestjs/common"`,
        `import { GrpcMethod } from "@nestjs/microservices"`,
        ``,
        `@Controller()`,
        `export class HeroesController {`,
        `  @GrpcMethod("HeroesService", "FindOne")`,
        `  findOne(data: { id: number }) { return { id: data.id, name: "John" } }`,
        `}`,
        ``,
      ].join("\n"),
    )
    await workspace.writeSource(
      "src/tasks.service.ts",
      [
        `import { Injectable } from "@nestjs/common"`,
        `import { OnEvent } from "@nestjs/event-emitter"`,
        `import { Cron } from "@nestjs/schedule"`,
        ``,
        `@Injectable()`,
        `export class TasksService {`,
        `  @Cron("45 * * * * *")`,
        `  handleCron() {}`,
        ``,
        `  @OnEvent("order.created")`,
        `  onOrder() {}`,
        `}`,
        ``,
      ].join("\n"),
    )
  })

  it.each([
    ["EventsController.stream", "framework:nestjs:route", "framework:nestjs:route:Sse", "Sse"],
    ["UsersResolver", "framework:nestjs:resolver", "framework:nestjs:resolver", "Resolver"],
    ["UsersResolver.users", "framework:nestjs:route", "framework:nestjs:route:Query", "Query"],
    [
      "UsersResolver.deleteUser",
      "framework:nestjs:route",
      "framework:nestjs:route:Mutation",
      "Mutation",
    ],
    ["ChatGateway", "framework:nestjs:gateway", "framework:nestjs:gateway", "WebSocketGateway"],
    [
      "HeroesController.findOne",
      "framework:nestjs:route",
      "framework:nestjs:route:GrpcMethod",
      "GrpcMethod",
    ],
  ])("classifies %s as %s and flags its decorator", async (name, extKind, tag, flagged) => {
    const symbol = symbolNamed(await scanWorkspace(), name)

    expect(symbol.extKind).toBe(extKind)
    expect(symbol.derivedBy).toContain(tag)
    expect(symbol.decorators.map((d) => [d.name, d.boundary])).toEqual([[flagged, true]])
  })

  it.each([
    ["TasksService.handleCron", "Cron"],
    ["TasksService.onOrder", "OnEvent"],
  ])("keeps %s, whose body is empty, as a handler NestJS calls", async (name, flagged) => {
    const symbol = symbolNamed(await scanWorkspace(), name)

    expect(symbol.extKind).toBeNull()
    expect(symbol.derivedBy).toContain(`framework:nestjs:trigger:${flagged}`)
    expect(symbol.decorators.map((d) => [d.name, d.boundary])).toEqual([[flagged, true]])
  })
})

describe("scan — a guard on a controller", () => {
  it("flags it as a boundary as it is on a handler", async () => {
    await workspace.writeSource(
      "src/cats.controller.ts",
      [
        `import { Controller, Delete, Get, Param, UseGuards } from "@nestjs/common"`,
        `import { AdminGuard, AuthGuard } from "./guards"`,
        ``,
        `@Controller("cats")`,
        `@UseGuards(AuthGuard)`,
        `export class CatsController {`,
        `  @Get()`,
        `  findAll() { return [] }`,
        ``,
        `  @Delete(":id")`,
        `  @UseGuards(AdminGuard)`,
        `  remove(@Param("id") id: string) { return id }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const flags = (name: string) =>
      symbolNamed(result, name).decorators.map((d) => [d.name, d.boundary])

    expect(flags("CatsController")).toEqual([
      ["Controller", true],
      ["UseGuards", true],
    ])
    expect(flags("CatsController.remove")).toEqual([
      ["Delete", true],
      ["UseGuards", true],
    ])
  })
})

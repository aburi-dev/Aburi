import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { nestEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("emit-effects")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [nestEffectsPlugin] })

describe("scan — event emitters in a NestJS service file", () => {
  it("publishes through eventBus or EventEmitter2, and leaves any other emit a call", async () => {
    await workspace.writeSource(
      "src/orders.service.ts",
      [
        'import { Injectable } from "@nestjs/common"',
        'import { EventEmitter2 } from "@nestjs/event-emitter"',
        "",
        "@Injectable()",
        "export class OrdersService {",
        "  constructor(private readonly eventBus: EventEmitter2) {}",
        "  create() {",
        '    this.eventBus.emit("order.created", { id: 1 })',
        "  }",
        "}",
        "",
        "export function publish(eventBus: EventEmitter2, socket: any) {",
        '  eventBus.emit("thing.happened", 1)',
        '  EventEmitter2.emit("thing.happened", 1)',
        '  socket.emit("update", {})',
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const publish = symbolNamed(result, "publish")

    expect(symbolNamed(result, "OrdersService.create").effects).toMatchObject([
      {
        id: "event.publish",
        target: "this.eventBus.emit",
        confidence: "high",
        derivedBy: "effects-plugin:nest:eventBus.emit",
      },
    ])
    expect(publish.effects).toMatchObject([
      {
        id: "event.publish",
        target: "eventBus.emit",
        derivedBy: "effects-plugin:nest:eventBus.emit",
      },
      {
        id: "event.publish",
        target: "EventEmitter2.emit",
        derivedBy: "effects-plugin:nest:EventEmitter2.emit",
      },
    ])
    expect(publish.calls.map((c) => c.target)).toEqual(["socket.emit"])
  })

  it("publishes through a field declared as EventEmitter2 or `readonly` and constructed from it, under any name, and leaves a gateway's socket a call", async () => {
    await workspace.writeSource(
      "src/orders.service.ts",
      [
        'import { Injectable } from "@nestjs/common"',
        'import { EventEmitter2 } from "@nestjs/event-emitter"',
        'import type { Server } from "socket.io"',
        "",
        "@Injectable()",
        "export class OrdersService {",
        "  private server!: Server",
        "  private readonly local = new EventEmitter2()",
        "  constructor(private readonly eventEmitter: EventEmitter2) {}",
        "  create(id: string) {",
        '    this.eventEmitter.emit("order.created", { id })',
        '    this.local.emit("order.cached", { id })',
        '    this.server.emit("order", id)',
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const create = symbolNamed(await scanWorkspace(), "OrdersService.create")

    expect(create.effects).toMatchObject([
      {
        id: "event.publish",
        target: "this.eventEmitter.emit",
        confidence: "high",
        derivedBy: "effects-plugin:nest:EventEmitter2.emit",
      },
      {
        id: "event.publish",
        target: "this.local.emit",
        confidence: "high",
        derivedBy: "effects-plugin:nest:EventEmitter2.emit",
      },
    ])
    expect(create.calls.map((c) => c.target)).toEqual(["this.server.emit"])
  })

  it("publishes through a parameter or a local declared as EventEmitter2, and leaves a socket parameter a call", async () => {
    await workspace.writeSource(
      "src/publish.ts",
      [
        'import { EventEmitter2 } from "@nestjs/event-emitter"',
        'import type { Server } from "socket.io"',
        "",
        "export function publish(bus: EventEmitter2, server: Server) {",
        "  const local = new EventEmitter2()",
        '  bus.emit("order.created", 1)',
        '  local.emit("order.created", 2)',
        '  server.emit("order", 3)',
        "}",
        "",
      ].join("\n"),
    )

    const publish = symbolNamed(await scanWorkspace(), "publish")

    expect(publish.effects).toMatchObject([
      {
        id: "event.publish",
        target: "bus.emit",
        derivedBy: "effects-plugin:nest:EventEmitter2.emit",
      },
      {
        id: "event.publish",
        target: "local.emit",
        derivedBy: "effects-plugin:nest:EventEmitter2.emit",
      },
    ])
    expect(publish.calls.map((c) => c.target)).toEqual(["EventEmitter2", "server.emit"])
  })

  it("publishes through `super` in a class that extends EventEmitter2", async () => {
    await workspace.writeSource(
      "src/bus.ts",
      [
        'import { EventEmitter2 } from "@nestjs/event-emitter"',
        "",
        "export class Bus extends EventEmitter2 {",
        "  send(id: number) {",
        '    return super.emit("order.created", id)',
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const send = symbolNamed(await scanWorkspace(), "Bus.send")

    expect(send.effects).toMatchObject([
      {
        id: "event.publish",
        target: "super.emit",
        derivedBy: "effects-plugin:nest:EventEmitter2.emit",
      },
    ])
    expect(send.calls).toEqual([])
  })

  it.each([
    ["an aliased import", 'import { EventEmitter2 as Bus } from "@nestjs/event-emitter"', "Bus"],
    ["a namespace import", 'import * as ee from "eventemitter2"', "ee.EventEmitter2"],
    ["a default import", 'import EventEmitter2 from "eventemitter2"', "EventEmitter2"],
  ])(
    "publishes through a field declared as the emitter class under the name %s binds",
    async (_label, importLine, type) => {
      await workspace.writeSource(
        "src/orders.service.ts",
        [
          importLine,
          "",
          "export class OrdersService {",
          `  constructor(private readonly prisma: PrismaClient, private readonly bus: ${type}) {}`,
          "  create(id: string) {",
          '    this.bus.emit("order.created", { id })',
          "  }",
          "}",
          "",
        ].join("\n"),
      )

      expect(symbolNamed(await scanWorkspace(), "OrdersService.create").effects).toMatchObject([
        {
          id: "event.publish",
          target: "this.bus.emit",
          confidence: "high",
          derivedBy: "effects-plugin:nest:EventEmitter2.emit",
        },
      ])
    },
  )

  it("publishes in a file that imports eventemitter2 itself", async () => {
    await workspace.writeSource(
      "src/publish.ts",
      [
        'import { EventEmitter2 } from "eventemitter2"',
        "",
        "export function publish(eventBus: EventEmitter2) {",
        '  eventBus.emit("raw.event", {})',
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolNamed(result, "publish").effects).toMatchObject([
      { id: "event.publish", target: "eventBus.emit" },
    ])
  })

  it("publishes nothing in a file whose emitter comes from Node's events module", async () => {
    await workspace.writeSource(
      "src/raise.ts",
      [
        'import { EventEmitter } from "events"',
        "",
        "export function raise(eventBus: EventEmitter) {",
        '  eventBus.emit("data", 1)',
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(result.ir.symbols.flatMap((s) => s.effects)).toEqual([])
    expect(symbolNamed(result, "raise").calls.map((c) => c.target)).toEqual(["eventBus.emit"])
  })
})

describe("scan — the publishing calls NestJS documents beside emit", () => {
  it("publishes through EventEmitter2's emitAsync, which waits for the listeners", async () => {
    await workspace.writeSource(
      "src/orders.service.ts",
      [
        'import { Injectable } from "@nestjs/common"',
        'import { EventEmitter2 } from "@nestjs/event-emitter"',
        "",
        "@Injectable()",
        "export class OrdersService {",
        "  constructor(private readonly eventEmitter: EventEmitter2) {}",
        "",
        "  async createAndWait(id: string) {",
        '    await this.eventEmitter.emitAsync("order.created", { id })',
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const createAndWait = symbolNamed(await scanWorkspace(), "OrdersService.createAndWait")

    expect(createAndWait.effects).toMatchObject([
      {
        id: "event.publish",
        target: "this.eventEmitter.emitAsync",
        confidence: "high",
        derivedBy: "effects-plugin:nest:EventEmitter2.emitAsync",
      },
    ])
    expect(createAndWait.calls).toEqual([])
  })

  it("publishes through @nestjs/cqrs's EventBus, and leaves its CommandBus a call", async () => {
    await workspace.writeSource(
      "src/heroes.service.ts",
      [
        'import { Injectable } from "@nestjs/common"',
        'import { CommandBus, EventBus } from "@nestjs/cqrs"',
        "",
        "export class HeroKilledDragonEvent {",
        "  constructor(public readonly heroId: string) {}",
        "}",
        "",
        "@Injectable()",
        "export class HeroesService {",
        "  constructor(",
        "    private readonly eventBus: EventBus,",
        "    private readonly events: EventBus,",
        "    private readonly commandBus: CommandBus,",
        "  ) {}",
        "",
        "  kill(heroId: string) {",
        "    this.eventBus.publish(new HeroKilledDragonEvent(heroId))",
        "    this.events.publishAll([new HeroKilledDragonEvent(heroId)])",
        "    return this.commandBus.execute({ heroId })",
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const kill = symbolNamed(await scanWorkspace(), "HeroesService.kill")

    expect(kill.effects).toMatchObject([
      {
        id: "event.publish",
        target: "this.eventBus.publish",
        confidence: "high",
        derivedBy: "effects-plugin:nest:eventBus.publish",
      },
      {
        id: "event.publish",
        target: "this.events.publishAll",
        confidence: "high",
        derivedBy: "effects-plugin:nest:EventBus.publishAll",
      },
    ])
    expect(kill.calls.map((c) => c.target)).toEqual([
      "HeroKilledDragonEvent",
      "HeroKilledDragonEvent",
      "this.commandBus.execute",
    ])
  })

  it("publishes through each library in a service that injects both", async () => {
    await workspace.writeSource(
      "src/orders.service.ts",
      [
        'import { Injectable } from "@nestjs/common"',
        'import { EventBus } from "@nestjs/cqrs"',
        'import { EventEmitter2 } from "@nestjs/event-emitter"',
        "",
        "@Injectable()",
        "export class OrdersService {",
        "  constructor(",
        "    private readonly emitter: EventEmitter2,",
        "    private readonly bus: EventBus,",
        "  ) {}",
        "",
        "  create(id: string) {",
        '    this.emitter.emit("order.created", { id })',
        "    this.bus.publish({ id })",
        "    this.bus.publishAll([{ id }])",
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const create = symbolNamed(await scanWorkspace(), "OrdersService.create")

    expect(create.effects.map((effect) => effect.derivedBy)).toEqual([
      "effects-plugin:nest:EventEmitter2.emit",
      "effects-plugin:nest:EventBus.publish",
      "effects-plugin:nest:EventBus.publishAll",
    ])
    expect(create.calls).toEqual([])
  })

  it("publishes nothing for the events an aggregate publishes itself", async () => {
    await workspace.writeSource(
      "src/hero.model.ts",
      [
        'import { AggregateRoot } from "@nestjs/cqrs"',
        "",
        "export class Hero extends AggregateRoot {",
        "  kill(event: object) {",
        "    this.apply(event)",
        "    this.publish(event)",
        "    this.publishAll([event])",
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const kill = symbolNamed(await scanWorkspace(), "Hero.kill")

    expect(kill.effects).toEqual([])
    expect(kill.calls.map((c) => c.target)).toEqual([
      "this.apply",
      "this.publish",
      "this.publishAll",
    ])
  })
})

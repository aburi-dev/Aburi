import { classifyInputsAround } from "@aburi/test-harness"
import { importEdge, makeCall, makeCtx } from "@aburi/test-support"
import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { classifyNestCall } from "../src/index"
import {
  makeEventemitter2Import,
  makeNestCqrsImport,
  makeNestEmitterImport,
} from "./fixtures/context"

const ctx = makeCtx({ imports: [makeNestEmitterImport()] })

describe("classifyNestCall — publishing calls", () => {
  it.each([
    ["eventBus.emit", "eventBus.emit"],
    ["this.eventBus.emit", "eventBus.emit"],
    ["container.services.eventBus.emit", "eventBus.emit"],
    ["EventEmitter2.emit", "EventEmitter2.emit"],
    ["this.eventBus.emitAsync", "eventBus.emitAsync"],
    ["EventEmitter2.emitAsync", "EventEmitter2.emitAsync"],
  ])("classifies %s as event.publish, tagged with the receiver it emits through", (target, tag) => {
    expect(classifyNestCall(makeCall({ target }), ctx)).toEqual({
      effectId: "event.publish",
      confidence: "high",
      derivedBy: `effects-plugin:nest:${tag}`,
    })
  })

  it.each([
    ["@nestjs/event-emitter", makeNestEmitterImport()],
    ["eventemitter2", makeEventemitter2Import()],
  ])("classifies in a file that imports %s", (_label, edge) => {
    expect(
      classifyNestCall(makeCall({ target: "eventBus.emit" }), makeCtx({ imports: [edge] }))
        ?.effectId,
    ).toBe("event.publish")
  })
})

describe("classifyNestCall — a receiver declared as the emitter class", () => {
  it.each([
    ["this.eventEmitter.emit", "EventEmitter2"],
    ["this.events.emit", "EventEmitter2"],
  ])(
    "classifies %s, whatever the field is called, tagged with the class",
    (target, receiverType) => {
      expect(classifyNestCall(makeCall({ target, receiverType }), ctx)).toEqual({
        effectId: "event.publish",
        confidence: "high",
        derivedBy: "effects-plugin:nest:EventEmitter2.emit",
      })
    },
  )

  it.each([
    ["the emitter class", "EventEmitter2"],
    ["a type the file's emitter import does not bind", "Server"],
  ])(
    "lets a recognised name decide, under its own tag, whatever it is declared as: %s",
    (_label, receiverType) => {
      const call = makeCall({ target: "this.eventBus.emit", receiverType })

      expect(classifyNestCall(call, ctx)).toEqual({
        effectId: "event.publish",
        confidence: "high",
        derivedBy: "effects-plugin:nest:eventBus.emit",
      })
    },
  )

  it.each([
    ["a type the file's emitter import does not bind", "this.socket.emit", "Server", ctx],
    ["a method other than emit", "this.events.on", "EventEmitter2", ctx],
    [
      "a file that imports no emitter module",
      "this.events.emit",
      "EventEmitter2",
      makeCtx({
        imports: [{ source: "./emitter", symbols: ["EventEmitter2"], line: 1, dynamic: false }],
      }),
    ],
  ])("returns null for %s", (_label, target, receiverType, context) => {
    expect(classifyNestCall(makeCall({ target, receiverType }), context)).toBeNull()
  })
})

describe("classifyNestCall — publishing through @nestjs/cqrs's EventBus", () => {
  const cqrs = makeCtx({ imports: [makeNestCqrsImport()] })

  it.each([
    ["this.eventBus.publish", undefined, "eventBus.publish"],
    ["this.eventBus.publishAll", undefined, "eventBus.publishAll"],
    ["this.bus.publish", "EventBus", "EventBus.publish"],
    ["bus.publishAll", "EventBus", "EventBus.publishAll"],
  ])("classifies %s as event.publish", (target, receiverType, tag) => {
    const call = makeCall({ target, ...(receiverType === undefined ? {} : { receiverType }) })

    expect(classifyNestCall(call, cqrs)).toEqual({
      effectId: "event.publish",
      confidence: "high",
      derivedBy: `effects-plugin:nest:${tag}`,
    })
  })

  it.each([
    [
      "a receiver neither named eventBus nor declared as EventBus",
      "this.bus.publish",
      "Server",
      cqrs,
    ],
    ["CommandBus, which dispatches to one handler", "this.commandBus.execute", "CommandBus", cqrs],
    ["emit in a file that imports `@nestjs/cqrs` alone", "this.eventBus.emit", "EventBus", cqrs],
    [
      "an EventBus of another module, beside a `@nestjs/cqrs` import of something else",
      "this.bus.publish",
      "EventBus",
      makeCtx({
        imports: [
          importEdge({ source: "@nestjs/cqrs", symbols: ["CommandBus"] }),
          importEdge({ source: "./bus", symbols: ["EventBus"], line: 2 }),
        ],
      }),
    ],
  ])("returns null for %s", (_label, target, receiverType, context) => {
    expect(classifyNestCall(makeCall({ target, receiverType }), context)).toBeNull()
  })
})

describe("classifyNestCall — a file that imports both libraries", () => {
  const both = makeCtx({ imports: [makeNestEmitterImport(), makeNestCqrsImport()] })

  it.each([
    ["this.bus.emit", "EventBus", null],
    ["this.emitter.publish", "EventEmitter2", null],
    ["this.emitter.emit", "EventEmitter2", "EventEmitter2.emit"],
    ["this.bus.publish", "EventBus", "EventBus.publish"],
  ])(
    "answers %s on a receiver declared as %s by whether that class has the method",
    (target, receiverType, tag) => {
      const expected =
        tag === null
          ? null
          : {
              effectId: "event.publish",
              confidence: "high",
              derivedBy: `effects-plugin:nest:${tag}`,
            }

      expect(classifyNestCall(makeCall({ target, receiverType }), both)).toEqual(expected)
    },
  )
})

describe("classifyNestCall — calls that are not a publish", () => {
  it.each([
    ["no import at all", []],
    [
      "Node's events module",
      [{ source: "events", symbols: ["EventEmitter"], line: 1, dynamic: false }],
    ],
  ])("returns null in a file that imports %s instead of an emitter module", (_label, imports) => {
    expect(classifyNestCall(makeCall({ target: "eventBus.emit" }), makeCtx({ imports }))).toBeNull()
  })

  it.each([
    ["socket.emit", "a receiver outside the identifier set"],
    ["process.emit", "a receiver outside the identifier set"],
    ["stream.emit", "a receiver outside the identifier set"],
    ["bus.emit", "a receiver outside the identifier set"],
    ["emitter.emit", "a receiver outside the identifier set"],
    ["this.emitter.emit", "a receiver outside the identifier set"],
    ["eventBus.emitAsyncSerial", "a method other than emit or emitAsync"],
    ["eventBus.emits", "a method other than emit or emitAsync"],
    ["eventBus.dispatch", "a method other than emit or emitAsync"],
    ["eventBus.publish", "CQRS's publish, in a file that imports no @nestjs/cqrs"],
    ["emit", "an emit with no receiver"],
    ["eventBus", "a bare identifier"],
  ])("returns null for %s — %s", (target) => {
    expect(classifyNestCall(makeCall({ target }), ctx)).toBeNull()
  })
})

describe("classifyNestCall — upstream contract violations", () => {
  const path = "src/orders/x.ts"

  it.each([
    ["", "CallCandidate.target is empty"],
    ["eventBus..emit", 'CallCandidate.target "eventBus..emit" has empty segment(s)'],
    [".emit", 'CallCandidate.target ".emit" has empty segment(s)'],
    ["eventBus.", 'CallCandidate.target "eventBus." has empty segment(s)'],
  ])(
    "throws on the malformed target %j, naming itself and the file, before the import gate",
    (target, message) => {
      for (const imports of [[makeNestEmitterImport()], []]) {
        expect(() => classifyNestCall(makeCall({ target }), makeCtx({ imports, path }))).toThrow(
          `effects-nest (${path}): ${message}`,
        )
      }
    },
  )

  const broken = importEdge({ source: "", symbols: ["EventEmitter2"], line: 4 })

  it.each(
    ["eventBus.emit", "this.eventBus.publish", "this.commandBus.execute", "logger.log"].flatMap(
      (target): [string, string, ImportEdge[]][] => [
        [target, "beside `@nestjs/cqrs`", [makeNestCqrsImport(), broken]],
        [target, "alone", [broken]],
      ],
    ),
  )(
    "throws for %s on an import edge with an empty source, %s, rather than skipping it",
    (target, _label, imports) => {
      expect(() => classifyNestCall(makeCall({ target }), makeCtx({ imports, path }))).toThrow(
        `effects-nest (${path}, line 4): ImportEdge.source is empty`,
      )
    },
  )

  it("leaves the CallCandidate and the ClassifyContext as it found them", () => {
    const { before, after } = classifyInputsAround(
      classifyNestCall,
      makeCall({ target: "eventBus.emit", literalArgs: ["order.created"] }),
      ctx,
    )
    expect(after).toEqual(before)
  })
})

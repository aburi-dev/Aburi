import { importEdge } from "@aburi/test-support"
import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  hasNestCqrsImport,
  hasNestEmitterImport,
  isNestEmitMethod,
  isNestEventEmitterIdentifier,
  isNestPublishMethod,
  NEST_EMIT_METHOD,
  NEST_EMIT_METHODS,
  NEST_EVENT_EMITTER_IDENTIFIERS,
  NEST_PUBLISH_METHODS,
  namesNestEmitterClass,
  namesNestEventBusClass,
} from "../src/index"

const PATH = "src/orders/service.ts"

function edge(source: string, line = 1): ImportEdge {
  return importEdge({ source, symbols: ["EventEmitter2"], line })
}

describe("hasNestEmitterImport", () => {
  it.each([
    ["@nestjs/event-emitter", [edge("@nestjs/event-emitter")]],
    ["eventemitter2", [edge("eventemitter2")]],
    [
      "an emitter module beside other imports",
      [edge("@nestjs/common", 1), edge("@nestjs/event-emitter", 2)],
    ],
  ])("returns true when the file imports %s", (_label, imports) => {
    expect(hasNestEmitterImport(imports, PATH)).toBe(true)
  })

  it.each([
    ["nothing", []],
    ["Node's events module", [edge("events")]],
    ["@nestjs/websockets, whose emit is another API", [edge("@nestjs/websockets")]],
  ])("returns false when the file imports %s", (_label, imports) => {
    expect(hasNestEmitterImport(imports, PATH)).toBe(false)
  })
})

describe("namesNestEmitterClass", () => {
  const namespaced = (source: string, namespaceBinding?: string) =>
    importEdge({
      source,
      symbols: "*",
      ...(namespaceBinding === undefined ? {} : { namespaceBinding }),
    })

  it.each([
    [
      "the class an emitter module's import binds",
      [edge("@nestjs/event-emitter")],
      "EventEmitter2",
    ],
    [
      "the local name an aliased import binds it to",
      [importEdge({ source: "eventemitter2", symbols: ["EventEmitter2 as Bus"] })],
      "Bus",
    ],
    [
      "the class reached through a namespace import",
      [namespaced("eventemitter2", "ee")],
      "ee.EventEmitter2",
    ],
    [
      "the default import of eventemitter2, which exports the class as its default",
      [importEdge({ source: "eventemitter2", symbols: ["default as Bus"] })],
      "Bus",
    ],
  ])("returns true for %s", (_label, imports, typeName) => {
    expect(namesNestEmitterClass(imports, typeName, PATH)).toBe(true)
  })

  it.each([
    ["a name the module's import does not bind", [edge("@nestjs/event-emitter")], "Bus"],
    [
      "the class's own name where the import aliases it",
      [importEdge({ source: "eventemitter2", symbols: ["EventEmitter2 as Bus"] })],
      "EventEmitter2",
    ],
    [
      "an emitter module's import that binds something else",
      [importEdge({ source: "@nestjs/event-emitter", symbols: ["OnEvent"] })],
      "EventEmitter2",
    ],
    ["a class of that name from another module", [edge("./local-emitter")], "EventEmitter2"],
    [
      "a class of that name from another module, beside an emitter module's import of something else",
      [
        edge("./local-emitter"),
        importEdge({ source: "@nestjs/event-emitter", symbols: ["OnEvent"], line: 2 }),
      ],
      "EventEmitter2",
    ],
    [
      "the default import of @nestjs/event-emitter, which has no default",
      [importEdge({ source: "@nestjs/event-emitter", symbols: ["default as EventEmitter2"] })],
      "EventEmitter2",
    ],
    [
      "a namespace import under another name",
      [namespaced("eventemitter2", "ee")],
      "events.EventEmitter2",
    ],
    [
      "a dynamic import, which binds no name",
      [namespaced("eventemitter2")],
      "undefined.EventEmitter2",
    ],
  ])("returns false for %s", (_label, imports, typeName) => {
    expect(namesNestEmitterClass(imports, typeName, PATH)).toBe(false)
  })
})

describe("hasNestCqrsImport", () => {
  it.each([
    ["@nestjs/cqrs", [edge("@nestjs/cqrs")], true],
    ["an emitter module", [edge("@nestjs/event-emitter")], false],
    ["a package sharing its prefix", [edge("@nestjs/cqrs-extras")], false],
  ])("answers for a file that imports %s", (_label, imports, expected) => {
    expect(hasNestCqrsImport(imports, PATH)).toBe(expected)
  })
})

describe("namesNestEventBusClass", () => {
  it.each([
    [
      "the class @nestjs/cqrs binds",
      [importEdge({ source: "@nestjs/cqrs", symbols: ["EventBus"] })],
      "EventBus",
      true,
    ],
    [
      "the local name an aliased import binds it to",
      [importEdge({ source: "@nestjs/cqrs", symbols: ["EventBus as Bus"] })],
      "Bus",
      true,
    ],
    [
      "the class reached through a namespace import",
      [importEdge({ source: "@nestjs/cqrs", symbols: "*", namespaceBinding: "cqrs" })],
      "cqrs.EventBus",
      true,
    ],
    [
      "a default import, which @nestjs/cqrs does not export",
      [importEdge({ source: "@nestjs/cqrs", symbols: ["default as EventBus"] })],
      "EventBus",
      false,
    ],
    [
      "CommandBus",
      [importEdge({ source: "@nestjs/cqrs", symbols: ["CommandBus"] })],
      "CommandBus",
      false,
    ],
    ["a class of that name from another module", [edge("./bus")], "EventBus", false],
  ])("answers for %s", (_label, imports, typeName, expected) => {
    expect(namesNestEventBusClass(imports, typeName, PATH)).toBe(expected)
  })
})

describe.each([
  ["hasNestEmitterImport", (imports: ImportEdge[]) => hasNestEmitterImport(imports, PATH)],
  [
    "namesNestEmitterClass",
    (imports: ImportEdge[]) => namesNestEmitterClass(imports, "EventEmitter2", PATH),
  ],
])("%s on a broken ImportEdge", (_name, read) => {
  it("throws on an empty ImportEdge.source, naming the plugin, the file, and the line", () => {
    expect(() => read([edge("", 9)])).toThrow(
      `effects-nest (${PATH}, line 9): ImportEdge.source is empty`,
    )
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    expect(() => read([edge("@nestjs/event-emitter", 1), edge("", 2)])).toThrow(
      /ImportEdge\.source is empty/,
    )
  })
})

describe("event-emitter identifier vocabulary", () => {
  it("lists exactly eventBus and EventEmitter2", () => {
    expect([...NEST_EVENT_EMITTER_IDENTIFIERS]).toEqual(["eventBus", "EventEmitter2"])
    expect(isNestEventEmitterIdentifier("eventBus")).toBe(true)
    expect(isNestEventEmitterIdentifier("EventEmitter2")).toBe(true)
  })

  it.each([
    "bus",
    "emitter",
    "dispatcher",
    "socket",
    "stream",
    "EVENTBUS",
    "EventBus",
    "eventemitter2",
  ])("rejects %s — generic names and case variants are not recognized", (name) => {
    expect(isNestEventEmitterIdentifier(name)).toBe(false)
  })
})

describe("emit methods", () => {
  it("are `emit` and `emitAsync`, which waits for the listeners", () => {
    expect([...NEST_EMIT_METHODS]).toEqual([NEST_EMIT_METHOD, "emitAsync"])
    expect(isNestEmitMethod("emit")).toBe(true)
    expect(isNestEmitMethod("emitAsync")).toBe(true)
  })

  it.each(["emitAsyncSerial", "emits", "emitEvent", "publish"])("reject %s", (name) => {
    expect(isNestEmitMethod(name)).toBe(false)
  })
})

describe("publish methods", () => {
  it("are EventBus's `publish` and `publishAll`", () => {
    expect([...NEST_PUBLISH_METHODS]).toEqual(["publish", "publishAll"])
  })

  it.each(["emit", "execute", "publishes", "Publish"])("reject %s", (name) => {
    expect(isNestPublishMethod(name)).toBe(false)
  })
})

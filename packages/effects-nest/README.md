# @aburi/effects-nest

NestJS effect plugin for `@aburi/core`. Classifies the calls that publish an
event, through `@nestjs/event-emitter`'s `EventEmitter2` or through
`@nestjs/cqrs`'s `EventBus`, into the core `event.publish` effect so the IR
captures decoupled event signalling without conflating it with regular method
calls.

Recognised shapes, where `<emit>` is `emit` or `emitAsync` (which waits for the
listeners) and `<publish>` is `publish` or `publishAll`:

| Source shape | Effect |
|---|---|
| `eventBus.<emit>(...)` | `event.publish` |
| `EventEmitter2.<emit>(...)` | `event.publish` |
| `this.<field>.<emit>(...)`, the field declared as `EventEmitter2` or `readonly` and constructed from it | `event.publish` |
| `bus.<emit>(...)`, `bus` a parameter, a variable declared as `EventEmitter2` or a `const` constructed from it | `event.publish` |
| `super.<emit>(...)` in a class that extends `EventEmitter2` | `event.publish` |
| `eventBus.<publish>(...)`, and `<publish>` on a receiver declared as `@nestjs/cqrs`'s `EventBus` (`constructor(private readonly events: EventBus)`) | `event.publish` |

The receiver is recognised by its name or by its declared type. The name check
is a case-sensitive exact match against a fixed set per method: `eventBus` and
`EventEmitter2` for `<emit>`, `eventBus` alone for `<publish>`, the name
NestJS's CQRS documentation injects its `EventBus` under.
`eventemitter2.emit(...)` and `myBus.emit(...)` intentionally fall through so
the recognizer is loud and narrow rather than heuristic. The type check covers the injection NestJS
documents, whatever the field is called:

```ts
constructor(private readonly eventEmitter: EventEmitter2) {}

create(id: string) {
  this.eventEmitter.emit("order.created", { id })
}
```

The type is the one the language plugin reads off the declaration: a
constructor parameter property or a typed field of the class, a `readonly`
field constructed from it (`private readonly bus = new EventEmitter2()`), a parameter or a
variable annotated with it (`publish(bus: EventEmitter2) { bus.emit(…) }`), or
a `const` constructed from it (`const bus = new EventEmitter2()`), and for
`super.emit(…)` the class the enclosing one extends (`class Bus extends
EventEmitter2`). It must be
the `EventEmitter2` the file imports from an emitter module: under its own
name, under an alias (`EventEmitter2 as Bus`), through a namespace
(`ee.EventEmitter2`), or as `eventemitter2`'s default import. An inherited
field, an untyped parameter and `this.hub.bus.emit(…)` carry no type and go
through the name check alone, so `bus.emit(…)` there stays a call. The name
check comes first: `this.eventBus.emit(…)` is a publish tagged `eventBus.emit`
whatever `eventBus` is declared as.

`EventBus` is read the same way, through the `@nestjs/cqrs` import that binds it
(under its own name, an alias or a namespace; the package has no default
export). `CommandBus` and `QueryBus` hand a command or a query to exactly one
handler and return its result, so `execute` is a call to that handler rather
than a broadcast.

Layered gate: an `<emit>` needs the owning file to import a recognised
event-emitter module (`@nestjs/event-emitter` or `eventemitter2`), a `<publish>`
needs it to import `@nestjs/cqrs`, and the receiver must be recognised.
`socket.emit(...)` on a file that imports the emitter module is NOT classified;
`eventBus.emit(...)` on a file that never imports it is NOT classified, and
neither is `eventBus.publish(...)` in a file that imports the emitter module
alone. Both signals required.

Not classified: an aggregate's own events, `this.apply(event)` inside an
`AggregateRoot` and its `commit()`, `publish()` and `publishAll()` after
`EventPublisher.mergeObjectContext(hero)`, since nothing at the call names the
bus; and the listeners (`@OnEvent()`,
`eventEmitter.on(…)`, `@EventsHandler()`), which receive an event rather than
publish one.

## Install

```bash
pnpm add -D @aburi/effects-nest
```

## Usage

```ts
import { nestEffectsPlugin } from "@aburi/effects-nest"
```

## See also

- [`docs/design/effect-plugin.md`](../../docs/design/effect-plugin.md)

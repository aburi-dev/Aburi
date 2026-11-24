---
"@aburi/effects-nest": minor
---

Record `event.publish` for EventEmitter2's `emitAsync` and for `@nestjs/cqrs`'s `EventBus`. `emitAsync`, which waits for the listeners, is now read beside `emit` on every receiver `emit` is read on: `this.eventEmitter.emitAsync("order.created", …)` beside `constructor(private readonly eventEmitter: EventEmitter2)` is a publish tagged `EventEmitter2.emitAsync`. In a file that imports `@nestjs/cqrs`, `publish` and `publishAll` on `eventBus`, or on a receiver declared as that package's `EventBus`, are a publish tagged `eventBus.<method>` or `EventBus.<method>`. `CommandBus` and `QueryBus` stay calls, and so does an aggregate's own `apply`, `publish` or `commit`, where nothing at the call names the bus.

`NestEmitMethod` widens from `"emit"` to `"emit" | "emitAsync"`, so `isNestEmitMethod("emitAsync")` is now true. The package also exports `hasNestCqrsImport`, `namesNestEventBusClass`, `isNestPublishMethod`, `NEST_CQRS_MODULE`, `NEST_EVENT_BUS_CLASS`, `NEST_EVENT_BUS_IDENTIFIER`, `NEST_EMIT_METHODS`, `NEST_PUBLISH_METHODS` and the `NestPublishMethod` type.

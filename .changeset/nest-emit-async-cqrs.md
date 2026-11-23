---
"@aburi/effects-nest": minor
---

Record `event.publish` for the other publishing calls NestJS documents. `emitAsync`, which waits for the listeners, is now read beside `emit` on every receiver `emit` is read on: `this.eventEmitter.emitAsync("order.created", …)` beside `constructor(private readonly eventEmitter: EventEmitter2)` is a publish tagged `EventEmitter2.emitAsync`. In a file that imports `@nestjs/cqrs`, `publish` and `publishAll` on `eventBus`, or on a receiver declared as that package's `EventBus`, are a publish tagged `eventBus.publish` or `EventBus.publishAll`; `CommandBus` and `QueryBus` stay calls. The package exports `hasNestCqrsImport`, `namesNestEventBusClass`, `isNestPublishMethod` and the constants they read.

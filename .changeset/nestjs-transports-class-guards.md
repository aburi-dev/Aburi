---
"@aburi/framework-nestjs": minor
---

More of NestJS's entry points are classified. `@Sse` and `@Search` are HTTP routes, and
`@GrpcMethod`, `@GrpcStreamMethod` and `@GrpcStreamCall` are routes beside the microservice and
WebSocket patterns. A class decorated `@Resolver` is `framework:nestjs:resolver` and one decorated
`@WebSocketGateway` is `framework:nestjs:gateway`; `@Query`, `@Mutation`, `@Subscription`,
`@ResolveField` and `@ResolveReference` make a method a route. `@Cron`, `@Interval` and `@Timeout`
(`@nestjs/schedule`) and `@OnEvent` (`@nestjs/event-emitter`) are boundaries, `derivedBy`
`framework:nestjs:trigger:<decorator>`, so a scheduled or event handler with an empty body is no
longer dropped. The GraphQL, schedule and event names count only when the scan traces them to that
package (`ResolvedDecoratorName.nestjsPackage`), since other libraries share them.

`@UseGuards`, `@UseInterceptors`, `@UsePipes` and `@UseFilters` on a controller, resolver or gateway
class are boundaries, as they are on a method; on a provider they still are not.

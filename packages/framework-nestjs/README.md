# @aburi/framework-nestjs

NestJS framework plugin for `@aburi/core`. Classifies Symbols the language
plugin discovers as NestJS-specific extKinds and toggles decorator boundaries
so the scan pipeline knows which methods are externally-observable entry
points.

Recognised vocabulary:

| Source shape | `extKind` |
|---|---|
| `@Module()` | `framework:nestjs:module` |
| `@Controller()` | `framework:nestjs:controller` |
| `@Injectable()` | `framework:nestjs:provider` |
| `@Catch()` | `framework:nestjs:filter` |
| `@Resolver()` from `@nestjs/graphql` | `framework:nestjs:resolver` |
| `@WebSocketGateway()` | `framework:nestjs:gateway` |
| `@Get / @Post / @Put / @Delete / @Patch / @Options / @Head / @Search / @All / @Sse` | `framework:nestjs:route` (method) |
| `@MessagePattern / @EventPattern / @SubscribeMessage` | `framework:nestjs:route` (method) |
| `@GrpcMethod / @GrpcStreamMethod / @GrpcStreamCall` | `framework:nestjs:route` (method) |
| `@Query / @Mutation / @Subscription / @ResolveField / @ResolveReference` from `@nestjs/graphql` | `framework:nestjs:route` (method) |
| `@Cron / @Interval / @Timeout` from `@nestjs/schedule`, `@OnEvent` from `@nestjs/event-emitter` | boundary flag only (method) |
| `@UseGuards / @UseInterceptors / @UsePipes / @UseFilters` | boundary flag only (method, or a controller, resolver or gateway class) |

Boundary decorators mark the Symbol as an observable entry point — `@aburi/core`'s
drop rules exempt these from the "empty body / no rules" drop path so route
handlers, and a scheduled or event handler with nothing in it yet, always survive
into the IR. A guard, interceptor, pipe or filter on a class is flagged where
NestJS runs it around the class's handlers: on a controller, a resolver or a
gateway, not on a provider. A method's `derivedBy` names what it is, most telling
first: `framework:nestjs:route:<decorator>`, then
`framework:nestjs:trigger:<decorator>` for a scheduled or event handler, then
`framework:nestjs:handler:<decorator>`.

A decorator is matched on the name it was imported under, and graded by where
the scan traced it: `high` from `@nestjs/*`, `medium` from any other module, and
not classified at all from another framework whose decorators share these names
(`routing-controllers`, `tsoa`, and the packages under `@angular/`,
`@decorators/`, `@foal/`, `@inversifyjs/`, `@midwayjs/`, `@overnightjs/`,
`@tsed/` and `@tsoa/`). A decorator no import binds is taken at its written
name, at `high`. The names other libraries give a meaning of their own
(`Query` is also `@nestjs/common`'s parameter decorator, `Resolver` and
`Mutation` are type-graphql's, `Timeout` and `Cron` are common words) count only
when the scan traces them to the package the table names; written unbound, or
from anywhere else, they classify nothing.

## Install

```bash
pnpm add -D @aburi/framework-nestjs
```

## Usage

```ts
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
```

`aburi init` writes `"framework-nestjs"` into `aburi.json` under `frameworks`,
which is the plugin manifest name the loader resolves (to `@aburi/framework-nestjs`
via the bare-name prefix — see
[`docs/extend/plugin-development.md`](../../docs/extend/plugin-development.md)). The short
framework id `"nestjs"` that component autodetect uses stays inside
`components[].frameworks`; the two fields carry different vocabularies and no
hand-editing is needed.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:nestjs:*`) plug into the shared vocab.
- [`docs/design/drop-list.md`](../../docs/design/drop-list.md)

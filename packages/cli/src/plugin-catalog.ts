export const LANGUAGE_TO_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["ts", "lang-typescript"],
  ["tsx", "lang-typescript"],
  ["js", "lang-typescript"],
  ["jsx", "lang-typescript"],
])

export const FRAMEWORK_TO_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["nestjs", "framework-nestjs"],
  ["nextjs", "framework-next"],
  ["react", "framework-react"],
  ["express", "framework-express"],
  ["trpc", "framework-trpc"],
])

/**
 * The packages each effects plugin's import gate opens on, by the name a manifest depends on. A
 * Prisma driver adapter, client extension or generated client is installed beside `@prisma/client`.
 */
export const DEPENDENCY_TO_EFFECTS_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["@prisma/client", "effects-prisma"],
  ["drizzle-orm", "effects-drizzle"],
  ["@nestjs/event-emitter", "effects-nest"],
  ["eventemitter2", "effects-nest"],
  ["@nestjs/cqrs", "effects-nest"],
  ["@trpc/client", "effects-trpc"],
  ["@trpc/react-query", "effects-trpc"],
  ["@trpc/next", "effects-trpc"],
])

export function pluginForDetectorId(
  field: "languages" | "frameworks",
  id: string,
): string | undefined {
  return (field === "languages" ? LANGUAGE_TO_PLUGIN : FRAMEWORK_TO_PLUGIN).get(id)
}

export function frameworkIdForPlugin(name: string): string | undefined {
  for (const [id, plugin] of FRAMEWORK_TO_PLUGIN) if (plugin === name) return id
  return undefined
}

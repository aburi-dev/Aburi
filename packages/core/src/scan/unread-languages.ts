import type { Component, ComponentId, LanguageId } from "@aburi/types"
import { buildComponentAttribution } from "./attribute"
import type { UnclaimedFile } from "./discover"

export interface UnreadLanguage {
  component: ComponentId
  language: LanguageId
  files: number
}

/**
 * A language the census gave a Component no file of, as its fallback does, warns of nothing, so
 * each is checked against the files discovery passed over.
 */
export function unreadLanguages(
  components: readonly Component[],
  unclaimed: readonly UnclaimedFile[],
): UnreadLanguage[] {
  const attribute = buildComponentAttribution(components)
  const counts = new Map<ComponentId, Map<LanguageId, number>>()
  for (const file of unclaimed) {
    const owner = attribute(file.path)
    if (owner === null) continue
    let perLanguage = counts.get(owner)
    if (perLanguage === undefined) {
      perLanguage = new Map()
      counts.set(owner, perLanguage)
    }
    perLanguage.set(file.language, (perLanguage.get(file.language) ?? 0) + 1)
  }
  return components.flatMap((component) =>
    component.languages.flatMap((language) => {
      const files = counts.get(component.id)?.get(language) ?? 0
      return files === 0 ? [] : [{ component: component.id, language, files }]
    }),
  )
}

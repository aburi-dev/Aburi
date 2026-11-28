import type { Component, ComponentId, FileComponent, RelativePath } from "@aburi/types"
import { toNfc } from "../codepoints"

export type ComponentAttribution = (file: string) => ComponentId | null

export type ComponentPlacement = (file: string) => FileComponent | null

export function buildComponentAttribution(components: readonly Component[]): ComponentAttribution {
  const place = buildComponentPlacement(components)
  return (file) => place(file)?.id ?? null
}

export function buildComponentPlacement(components: readonly Component[]): ComponentPlacement {
  const byRoot = new Map<string, Component>()
  for (const component of components) {
    for (const root of component.roots) {
      const key = rootKey(root)
      if (key === null) continue
      const claimed = byRoot.get(key)
      if (claimed === undefined || component.id < claimed.id) byRoot.set(key, component)
    }
  }
  const placed = new Map<string, FileComponent>()
  for (const [key, component] of byRoot) {
    placed.set(key, {
      id: component.id,
      root: (key === WORKSPACE_ROOT_KEY ? "." : key) as RelativePath,
      frameworks: component.frameworks ?? [],
    })
  }
  return (file) => attributeFile(placed, file)
}

const WORKSPACE_ROOT_KEY = ""

function pathSegments(path: string): string[] {
  return toNfc(path)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
}

function rootKey(root: string): string | null {
  const segments = pathSegments(root)
  if (segments.some((segment) => segment === "..")) return null
  if (segments.length > 0) return segments.join("/")
  return toNfc(root).split("/").includes(".") ? WORKSPACE_ROOT_KEY : null
}

function attributeFile(
  byRoot: ReadonlyMap<string, FileComponent>,
  file: string,
): FileComponent | null {
  if (byRoot.size === 0) return null
  const segments = pathSegments(file)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === "..")) return null
  for (let end = segments.length; end > 0; end--) {
    const owner = byRoot.get(segments.slice(0, end).join("/"))
    if (owner !== undefined) return owner
  }
  return byRoot.get(WORKSPACE_ROOT_KEY) ?? null
}

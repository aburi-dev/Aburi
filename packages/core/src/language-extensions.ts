import type { LanguageId } from "@aburi/types"
import { makeLanguageId } from "./id"
import { fileExtension } from "./scan/route"

const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".jsx", "jsx"],
  [".py", "py"],
  [".go", "go"],
  [".rs", "rs"],
  [".java", "java"],
  [".kt", "kt"],
  [".kts", "kt"],
  [".scala", "scala"],
  [".rb", "rb"],
  [".php", "php"],
  [".cs", "cs"],
  [".swift", "swift"],
  [".ex", "ex"],
  [".exs", "ex"],
])

export function languageOfExtension(file: string): LanguageId | null {
  const extension = fileExtension(file)
  const raw = extension === null ? undefined : EXTENSION_TO_LANGUAGE.get(extension)
  if (raw === undefined) return null
  return makeLanguageId(raw)
}

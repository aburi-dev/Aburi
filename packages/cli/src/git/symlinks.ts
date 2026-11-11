import { lstat } from "node:fs/promises"
import { resolve } from "node:path"
import type { IR } from "@aburi/types"
import { joinCapped } from "../listing"
import { pathsWithMode } from "./index-listing"

/** Tracked links that git wrote under `checkoutRoot` as plain files holding their targets. */
export async function plainFileLinks(
  indexListing: string,
  checkoutRoot: string,
): Promise<string[]> {
  const links = pathsWithMode(indexListing, "120000")
  const regular = await Promise.all(links.map((path) => isRegularFile(resolve(checkoutRoot, path))))
  return links.filter((_, at) => regular[at])
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    // Deleted from the working tree, or a name the filesystem cannot hold: nothing a scan reads.
    return false
  }
}

/** A link no Symbol came from puts nothing into a diff, whatever git wrote in its place. */
export function linksReadAsSource(links: readonly string[], ir: IR): string[] {
  if (links.length === 0) return []
  const files = new Set<string>(ir.symbols.map((symbol) => symbol.source.file))
  return links.filter((path) => files.has(path.normalize("NFC")))
}

const REMEDY: Record<"base" | "head", string> = {
  base: "git writes a link that way while core.symlinks is false; set it to true where links can be created (on Windows, with Developer Mode).",
  head:
    "Set core.symlinks to true where links can be created (on Windows, with Developer Mode), then check them out again with `git checkout -- <path>`, " +
    "since a change to the setting leaves the files already checked out as they are.",
}

export function describeLinksReadAsSource(
  side: keyof typeof REMEDY,
  read: readonly string[],
): string {
  return (
    `${read.length} symbolic link(s) checked out as plain files holding their targets were read as source, ` +
    `where a scan passes over a link: ${joinCapped(read)}. ${REMEDY[side]}`
  )
}

import changelogGit from "@changesets/changelog-git"

function byName(a, b) {
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

export default {
  getReleaseLine: changelogGit.getReleaseLine,
  // changelog-git writes a line per changeset that bumped a dependency, each naming only a commit.
  async getDependencyReleaseLine(_changesets, dependenciesUpdated) {
    if (dependenciesUpdated.length === 0) return ""
    const versions = dependenciesUpdated
      .toSorted(byName)
      .map(({ name, newVersion }) => `\`${name}@${newVersion}\``)
    return `- Updated dependencies: ${versions.join(", ")}`
  },
}

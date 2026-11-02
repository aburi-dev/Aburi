import changelogGit from "@changesets/changelog-git"

export default {
  getReleaseLine: changelogGit.getReleaseLine,
  // changelog-git writes a line per changeset that bumped a dependency, each naming only a commit.
  async getDependencyReleaseLine(_changesets, dependenciesUpdated) {
    if (dependenciesUpdated.length === 0) return ""
    const versions = dependenciesUpdated.map(({ name, newVersion }) => `\`${name}@${newVersion}\``)
    return `- Updated dependencies: ${versions.join(", ")}`
  },
}

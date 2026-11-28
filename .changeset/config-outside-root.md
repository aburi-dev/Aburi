---
"@aburi/cli": patch
---

A config kept outside the workspace, such as one named by `--config ../shared.json` or shared from a directory above several repositories, is now said to be outside the workspace root, not below it. A config in a subdirectory still sits below it. Both lines add that the paths inside the config resolve against the root, not against the config's own directory.

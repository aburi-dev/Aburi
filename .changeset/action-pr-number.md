---
"@aburi/github-action": minor
---

A new `pr-number` input names the pull request to comment on. On an event that carries no pull request, such as `push`, `schedule` or `workflow_dispatch`, and with no `pr-number`, the comment step is skipped with a notice instead of failing the job on a clean diff.

# Picks the pull request the comment goes on: `pr-number`, else the event's own. An event that
# carries none (a push, a schedule, a dispatch) and no `pr-number` is not a failure of the diff.
set -euo pipefail

number=${PR_INPUT:-${EVENT_PR:-}}
if [ -z "$number" ]; then
  echo "::notice::No pull request to comment on: this ${GITHUB_EVENT_NAME:-} event carries none and pr-number is empty, so the report at $MARKDOWN_PATH was not posted. Set pr-number to post it, or comment: false to skip this step." >&2
fi
echo "number=$number" >> "$GITHUB_OUTPUT"
